
// app.js - PTT Walkie Talkie with Firebase signaling (compat)
const ADMIN_EMAIL = "akiranazuka21@gmail.com";

const auth = firebase.auth();
const db = firebase.database();

// UI refs
const displayUser = document.getElementById('displayUser');
const displayRoom = document.getElementById('displayRoom');
const signalBar = document.getElementById('signalBar');
const audioLevel = document.getElementById('audioLevel');
const onlineCount = document.getElementById('onlineCount');
const onlineList = document.getElementById('onlineList');
const roomSelect = document.getElementById('roomSelect');
const btnUp = document.getElementById('btnUp');
const btnDown = document.getElementById('btnDown');
const btnPTT = document.getElementById('btnPTT');
const btnHold = document.getElementById('btnHold');
const btnLogin = document.getElementById('btnLogin');
const btnRegister = document.getElementById('btnRegister');
const btnLogout = document.getElementById('btnLogout');
const emailEl = document.getElementById('email');
const passEl = document.getElementById('password');
const authRow = document.getElementById('authRow');
const remoteAudio = document.getElementById('remoteAudio');

// sounds
const beep1 = new Audio('sound/beep1.mp3');
const beep2 = new Audio('sound/beep2.mp3');
const beep3 = new Audio('sound/beep3.mp3');

// state
let currentUser = null;
let currentRoom = null;
let pcs = {}; // map peerId -> RTCPeerConnection for incoming streams
let localStream = null;
let holdMode = false;

// create default channels 01-25 if not exist
function ensureDefaultChannels(){
  const roomsRef = db.ref('rooms');
  roomsRef.once('value').then(snap=>{
    if(!snap.exists()){
      const data = {};
      for(let i=1;i<=25;i++){
        const k = String(i).padStart(2,'0');
        data[k] = { name: 'Channel '+k, isPrivate: false };
      }
      roomsRef.set(data);
    }
  });
}

ensureDefaultChannels();

// populate select (listen realtime)
db.ref('rooms').on('value', snap=>{
  roomSelect.innerHTML='';
  snap.forEach(child=>{
    const r = child.val();
    const opt = document.createElement('option');
    opt.value = child.key;
    opt.textContent = r.isPrivate ? ('★ '+ r.name) : r.name;
    if(r.isPrivate) opt.style.color = 'red';
    roomSelect.appendChild(opt);
  });
  // set default if none selected
  if(!currentRoom && roomSelect.options.length) {
    roomSelect.selectedIndex = 0;
    changeRoom(roomSelect.value);
  }
});

// Auth handlers
btnRegister.onclick = ()=>{
  const email = emailEl.value.trim();
  const pass = passEl.value;
  if(!email || !pass) return alert('Isi email & password');
  auth.createUserWithEmailAndPassword(email, pass)
    .then(()=> alert('Registrasi sukses, silakan login'))
    .catch(e=> alert(e.message));
};

btnLogin.onclick = ()=>{
  const email = emailEl.value.trim();
  const pass = passEl.value;
  if(!email || !pass) return alert('Isi email & password');
  auth.signInWithEmailAndPassword(email, pass).catch(e=> alert(e.message));
};

btnLogout.onclick = ()=> auth.signOut();

auth.onAuthStateChanged(user=>{
  currentUser = user;
  if(user){
    displayUser.textContent = 'User: '+ user.email + (user.email===ADMIN_EMAIL ? ' (admin)' : ' (user)');
    authRow.classList.add('hidden');
    btnLogout.classList.remove('hidden');
    // join currentRoom if exists
    if(currentRoom) joinPresence(currentRoom);
  } else {
    displayUser.textContent = '-';
    authRow.classList.remove('hidden');
    btnLogout.classList.add('hidden');
    // clear presence local
    if(currentRoom) leavePresence(currentRoom);
  }
});

// presence: join room
function joinPresence(roomKey){
  if(!currentUser) return;
  const uid = currentUser.uid;
  const ref = db.ref(`rooms/${roomKey}/presence/${uid}`);
  ref.set({ email: currentUser.email || 'anon', ts: Date.now() });
  ref.onDisconnect().remove();
  // listen count
  db.ref(`rooms/${roomKey}/presence`).on('value', snap=>{
    const val = snap.val()||{};
    onlineCount.textContent = Object.keys(val).length;
    // show list (emails)
    const emails = Object.values(val).map(v=>v.email || 'anon');
    onlineList.innerHTML = '👥 Online: '+ emails.length + '<br/>' + emails.slice(0,10).map(e=>'- '+e).join('<br/>');
  });
}

// leave presence
function leavePresence(roomKey){
  if(!currentUser) return;
  db.ref(`rooms/${roomKey}/presence/${currentUser.uid}`).remove();
  db.ref(`rooms/${roomKey}/presence`).off();
  onlineCount.textContent = '0';
  onlineList.innerHTML = '👥 Online: 0';
}

// change room handler
function changeRoom(roomKey){
  if(currentRoom===roomKey) return;
  // cleanup listeners for signaling of old room
  if(currentRoom){
    leavePresence(currentRoom);
    detachSignalingListeners(currentRoom);
  }
  currentRoom = roomKey;
  displayRoom.textContent = 'Channel '+ roomKey;
  roomSelect.value = roomKey;
  beep2.play();
  // join presence for new room
  if(currentUser) joinPresence(currentRoom);
  attachSignalingListeners(currentRoom);
}

// attach basic signaling listeners: listen offers from others
const offerListeners = {};
const answerListeners = {};
const candidateListeners = {};

function attachSignalingListeners(roomKey){
  const offersRef = db.ref(`rooms/${roomKey}/offers`);
  offerListeners[roomKey] = offersRef.on('child_added', snap=>{
    const fromId = snap.key;
    const offer = snap.val();
    if(!currentUser) return;
    if(fromId === currentUser.uid) return; // ignore own offer
    // create peer connection to answer offer
    createAndAnswerPeer(fromId, offer, roomKey);
  });
  // listen candidates
  const candRef = db.ref(`rooms/${roomKey}/candidates`);
  candidateListeners[roomKey] = candRef.on('child_added', snap=>{
    const sender = snap.key;
    const data = snap.val();
    // data is a list of pushed candidate objects; iterate children
    for(const k in data){
      const cand = data[k];
      // add to pc if exists
      const pc = pcs[sender];
      if(pc && cand && cand.candidate){
        pc.addIceCandidate(new RTCIceCandidate(cand.candidate)).catch(()=>{});
      }
    }
  });
  // listen answers targeted at me (when I created offer)
  const answersRef = db.ref(`rooms/${roomKey}/answers/${currentUser ? currentUser.uid : '__no__'}`);
  answerListeners[roomKey] = answersRef.on('child_added', snap=>{
    const responderId = snap.key;
    const ans = snap.val();
    // ans should be an object with sdp
    const myPc = pcs['pc-'+responderId]; // we store outgoing pcs with key 'pc-'+responderId
    if(myPc && ans){
      myPc.setRemoteDescription(new RTCSessionDescription(ans)).catch(()=>{});
    }
  });
}

function detachSignalingListeners(roomKey){
  if(offerListeners[roomKey]) db.ref(`rooms/${roomKey}/offers`).off('child_added', offerListeners[roomKey]);
  if(candidateListeners[roomKey]) db.ref(`rooms/${roomKey}/candidates`).off('child_added', candidateListeners[roomKey]);
  if(answerListeners[roomKey]) db.ref(`rooms/${roomKey}/answers/${currentUser ? currentUser.uid : '__no__'}`).off('child_added', answerListeners[roomKey]);
}

// create pc and answer an offer (for listeners)
async function createAndAnswerPeer(offererId, offer, roomKey){
  try{
    const pc = new RTCPeerConnection();
    pcs[offererId] = pc;
    pc.ontrack = e=>{
      remoteAudio.srcObject = e.streams[0];
    };
    pc.onicecandidate = e=>{
      if(e.candidate){
        // push candidate under rooms/{room}/candidates/{myUid}/{pushId}
        const cRef = db.ref(`rooms/${roomKey}/candidates/${currentUser.uid}`).push();
        cRef.set({ candidate: e.candidate.toJSON() });
      }
    };
    // set remote description and create answer
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    // add local audio muted? We are listener -> don't add local tracks
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    // write answer under rooms/{room}/answers/{offererId}/{myUid}
    await db.ref(`rooms/${roomKey}/answers/${offererId}/${currentUser.uid}`).set(pc.localDescription.toJSON());
  }catch(err){ console.error('answer error', err) }
}

// when we start speaking: create offers to all listeners by writing offer under rooms/{room}/offers/{myUid}
// Then listeners will answer under rooms/{room}/answers/{myUid}/{responderUid}
async function startSpeaking(){
  if(!currentUser) { alert('Login dulu'); return; }
  // capture mic
  try{
    localStream = await navigator.mediaDevices.getUserMedia({ audio:true });
  }catch(e){
    alert('Tidak bisa akses microphone: '+ e.message);
    return;
  }
  // create pc for outgoing
  const pc = new RTCPeerConnection();
  pcs['outgoing'] = pc;
  localStream.getTracks().forEach(t=>pc.addTrack(t, localStream));
  pc.onicecandidate = e=>{
    if(e.candidate){
      const cRef = db.ref(`rooms/${currentRoom}/candidates/${currentUser.uid}`).push();
      cRef.set({ candidate: e.candidate.toJSON() });
    }
  };
  // create offer and publish
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await db.ref(`rooms/${currentRoom}/offers/${currentUser.uid}`).set(offer);
  // listen for answers under rooms/{room}/answers/{myUid}
  db.ref(`rooms/${currentRoom}/answers/${currentUser.uid}`).on('child_added', snap=>{
    const responderId = snap.key;
    const ans = snap.val();
    if(ans && !pc.currentRemoteDescription){
      pc.setRemoteDescription(new RTCSessionDescription(ans)).catch(()=>{});
    }
  });
}

// stop speaking: close outgoing pc, remove offers and candidates from DB (cleanup)
async function stopSpeaking(){
  // close outgoing pc
  const pc = pcs['outgoing'];
  if(pc){ pc.close(); delete pcs['outgoing']; }
  if(localStream){ localStream.getTracks().forEach(t=>t.stop()); localStream = null; }
  // cleanup DB entries for my offers/candidates
  if(currentUser && currentRoom){
    db.ref(`rooms/${currentRoom}/offers/${currentUser.uid}`).remove().catch(()=>{});
    db.ref(`rooms/${currentRoom}/candidates/${currentUser.uid}`).remove().catch(()=>{});
    db.ref(`rooms/${currentRoom}/answers/${currentUser.uid}`).remove().catch(()=>{});
  }
}

// attach UI events
roomSelect.addEventListener('change', e=> changeRoom(e.target.value));
btnUp.onclick = ()=>{ beep1.play(); const idx = roomSelect.selectedIndex; const next = Math.max(0, idx-1); roomSelect.selectedIndex = next; changeRoom(roomSelect.value); };
btnDown.onclick = ()=>{ beep1.play(); const idx = roomSelect.selectedIndex; const next = Math.min(roomSelect.options.length-1, idx+1); roomSelect.selectedIndex = next; changeRoom(roomSelect.value); };

btnPTT.onmousedown = ()=>{ // mouse/touch down start speaking
  if(!holdMode){ btnPTT.classList.add('active'); beep3.play(); startSpeaking(); }
};
btnPTT.onmouseup = ()=>{ if(!holdMode){ btnPTT.classList.remove('active'); stopSpeaking(); } };
btnPTT.ontouchstart = ()=>{ if(!holdMode){ btnPTT.classList.add('active'); beep3.play(); startSpeaking(); } };
btnPTT.ontouchend = ()=>{ if(!holdMode){ btnPTT.classList.remove('active'); stopSpeaking(); } };

btnHold.onclick = ()=>{ holdMode = !holdMode; btnHold.textContent = holdMode? 'Stop HOLD':'HOLD'; beep3.play(); if(holdMode){ startSpeaking(); btnPTT.classList.add('active'); } else { stopSpeaking(); btnPTT.classList.remove('active'); } };

// initial default change room when DOM ready
function changeRoom(rk){ changeRoomHandler(rk); }
function changeRoomHandler(rk){
  if(currentRoom===rk) return;
  if(currentRoom){
    leavePresence(currentRoom);
    detachSignalingListeners(currentRoom);
  }
  currentRoom = rk;
  displayRoom.textContent = 'Channel '+ rk;
  roomSelect.value = rk;
  if(currentUser) joinPresence(currentRoom);
  attachSignalingListeners(currentRoom);
}

// presence helpers reused
function joinPresence(roomKey){
  if(!currentUser) return;
  const uid = currentUser.uid;
  const ref = db.ref(`rooms/${roomKey}/presence/${uid}`);
  ref.set({ email: currentUser.email || 'anon', ts: Date.now() });
  ref.onDisconnect().remove();
  db.ref(`rooms/${roomKey}/presence`).on('value', snap=>{
    const val = snap.val()||{};
    onlineCount.textContent = Object.keys(val).length;
    const emails = Object.values(val).map(v=>v.email||'anon');
    onlineList.innerHTML = '👥 Online: '+emails.length + '<br/>'+emails.slice(0,10).map(e=>'- '+e).join('<br/>');
  });
}
function leavePresence(roomKey){
  if(!currentUser) return;
  db.ref(`rooms/${roomKey}/presence/${currentUser.uid}`).remove();
  db.ref(`rooms/${roomKey}/presence`).off();
  onlineCount.textContent = '0'; onlineList.innerHTML = '👥 Online: 0';
}

// auto sign-in anonymously if not logged in
auth.onAuthStateChanged(u=>{
  if(u){
    currentUser = u;
    displayUser.textContent = 'User: '+(u.email||'anon') + (u.email===ADMIN_EMAIL? ' (admin)': ' (user)');
    authRow.classList.add('hidden');
    btnLogout.classList.remove('hidden');
    if(currentRoom) joinPresence(currentRoom);
  } else {
    // try anonymous sign-in
    auth.signInAnonymously().catch(()=>{});
    authRow.classList.remove('hidden');
    btnLogout.classList.add('hidden');
  }
});

// set initial room selection when rooms loaded
db.ref('rooms').once('value').then(snap=>{
  if(!snap.exists()) return;
  const first = Object.keys(snap.val())[0];
  if(first) { roomSelect.value = first; changeRoomHandler(first); }
});

// cleanup on unload: remove presence
window.addEventListener('beforeunload', ()=>{
  if(currentUser && currentRoom) db.ref(`rooms/${currentRoom}/presence/${currentUser.uid}`).remove();
});
