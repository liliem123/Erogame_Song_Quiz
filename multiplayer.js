// Firebase compat CDN wrappers.
// GitHub Pages에서 ES module import가 실패해 전체 JS가 멈추는 경우를 피하기 위해
// 공식 compat CDN을 사용하고, 기존 멀티플레이 코드와 동일한 함수 형태로 감싼다.
function initializeApp(config){ return firebase.initializeApp(config); }
function getDatabase(app){ return firebase.database(); }
function ref(database,path){ return database.ref(path); }
function set(r,value){ return r.set(value); }
function get(r){ return r.once("value"); }
function update(r,value){ return r.update(value); }
function onValue(r,callback){
  r.on("value",callback);
  return ()=>r.off("value",callback);
}
function runTransaction(r,updater){
  return new Promise((resolve,reject)=>{
    r.transaction(
      updater,
      (error,committed,snapshot)=>{
        if(error){ reject(error); return; }
        resolve({committed,snapshot});
      },
      false
    );
  });
}
function push(r){ return r.push(); }
function remove(r){ return r.remove(); }
function onDisconnect(r){ return r.onDisconnect(); }
function serverTimestamp(){ return firebase.database.ServerValue.TIMESTAMP; }

const $=s=>document.querySelector(s);
const cfg=window.EROGE_FIREBASE_CONFIG||{};
const configured=cfg.apiKey && !String(cfg.apiKey).includes("PASTE_") &&
                 cfg.databaseURL && !String(cfg.databaseURL).includes("PASTE_");

let firebaseApp=null, db=null;
let quizData=[];
let roomCode="", nickname="", playerId="", isHost=false;
let roomState=null, playerState={};
let currentQuestion=null;
let roomUnsub=null, playersUnsub=null, eventsUnsub=null;
let ytPlayer=null, ytReady=false, apiLoaded=false;
let candidateIds=[], candidateIndex=0;

function norm(s){
  return (s||"").normalize("NFKC").toLowerCase()
    .replace(/[\s·・'"“”‘’!?.,:;()[\]{}\-_/]/g,"");
}
function shuffle(a){
  for(let i=a.length-1;i>0;i--){
    const j=Math.floor(Math.random()*(i+1));
    [a[i],a[j]]=[a[j],a[i]];
  }
  return a;
}
function uniq(a){return [...new Set(a.filter(Boolean))];}
function randomCode(){
  const chars="ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s="";
  for(let i=0;i<6;i++)s+=chars[Math.floor(Math.random()*chars.length)];
  return s;
}
function randomPlayerId(){
  return crypto.randomUUID ? crypto.randomUUID().replaceAll("-","").slice(0,16)
                           : Math.random().toString(36).slice(2,18);
}
function esc(v){
  return String(v??"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;");
}

async function loadQuiz(){
  const r=await fetch(`./data/quiz.json?v=${Date.now()}`,{cache:"no-store"});
  if(!r.ok)throw new Error(`quiz.json HTTP ${r.status}`);
  let xs=await r.json();
  if(!Array.isArray(xs))xs=xs.quiz||xs.items||xs.data||[];
  quizData=xs.map((x,i)=>({
    ...x,
    game:x.game||x.anime||x.title||"",
    anime:x.anime||x.game||x.title||"",
    song:x.song||x.songTitle||"",
    vocal:x.vocal||x.artist||x.singer||"",
    videoIds:uniq((Array.isArray(x.videoIds)&&x.videoIds.length)?x.videoIds:(x.videoId?[x.videoId]:[])),
    __index:i
  })).filter(x=>x.game&&x.song);
  buildYears();
}

function buildYears(){
  const years=uniq(quizData.map(x=>Number(x.year)).filter(Boolean)).sort((a,b)=>b-a);
  $("#hostYear").innerHTML=years.map(y=>`<option value="${y}">${y}년</option>`).join("");
}
$("#hostMode").onchange=e=>{$("#hostYear").hidden=e.target.value!=="year";};

function initFirebase(){
  if(!configured){
    $("#firebaseWarning").hidden=false;
    $("#firebaseWarning").textContent="Firebase 설정값을 확인해주세요.";
    return false;
  }

  try{
    if(typeof firebase==="undefined"){
      throw new Error("Firebase SDK를 불러오지 못했습니다.");
    }
    firebaseApp=initializeApp(cfg);
    db=getDatabase(firebaseApp);
    console.log("[EROGE MP] Firebase initialized:", cfg.databaseURL);
    $("#firebaseWarning").hidden=true;
    return true;
  }catch(e){
    console.error("[EROGE MP] Firebase init failed:",e);
    $("#firebaseWarning").hidden=false;
    $("#firebaseWarning").textContent=`Firebase 초기화 실패: ${e.message}`;
    db=null;
    return false;
  }
}

function makeOrder(mode,year,count){
  let pool=quizData.map(x=>x.__index);
  if(mode==="year")pool=quizData.filter(x=>Number(x.year)===Number(year)).map(x=>x.__index);
  shuffle(pool);
  if(count!=="all")pool=pool.slice(0,Math.min(Number(count),pool.length));
  return pool;
}

async function createRoom(){
  if(!db)return alert("Firebase 설정을 먼저 완료해주세요.");
  const name=$("#hostNickname").value.trim();
  if(!name)return alert("닉네임을 입력해주세요.");
  const mode=$("#hostMode").value;
  const year=mode==="year"?Number($("#hostYear").value):null;
  const count=$("#hostCount").value;
  const order=makeOrder(mode,year,count);
  if(!order.length)return alert("해당 조건의 문제가 없습니다.");

  let code;
  for(let i=0;i<10;i++){
    code=randomCode();
    const snap=await get(ref(db,`rooms/${code}/meta`));
    if(!snap.exists())break;
  }
  roomCode=code; nickname=name; playerId=randomPlayerId(); isHost=true;

  await set(ref(db,`rooms/${roomCode}`),{
    meta:{
      hostId:playerId,createdAt:Date.now(),mode,year:year||null,
      status:"playing",questionIndex:0,questionToken:1,
      order,gameSolvedBy:null,songSolvedBy:null,forcedReveal:false,
      playback:{state:"playing",position:0,updatedAt:Date.now()}
    },
    players:{
      [playerId]:{nickname,score:0,joinedAt:Date.now(),online:true}
    }
  });
  await addEvent(`${nickname}님이 방을 만들었습니다.`,"system");
  enterRoom();
}

async function joinRoom(){
  if(!db)return alert("Firebase 설정을 먼저 완료해주세요.");
  const name=$("#joinNickname").value.trim();
  const code=$("#joinRoomCode").value.trim().toUpperCase();
  if(!name||code.length!==6)return alert("닉네임과 6자리 ROOM CODE를 입력해주세요.");

  const roomSnap=await get(ref(db,`rooms/${code}/meta`));
  if(!roomSnap.exists())return alert("존재하지 않는 방입니다.");
  if(roomSnap.val().status==="finished")return alert("이미 종료된 방입니다.");

  roomCode=code; nickname=name; playerId=randomPlayerId(); isHost=false;
  const pref=ref(db,`rooms/${roomCode}/players/${playerId}`);
  await set(pref,{nickname,score:0,joinedAt:Date.now(),online:true});
  
  await addEvent(`${nickname}님이 참가했습니다.`,"system");
  enterRoom();
}

async function addEvent(text,type="system"){
  if(!db||!roomCode)return;
  const e=push(ref(db,`rooms/${roomCode}/events`));
  await set(e,{text,type,at:serverTimestamp()});
}


let applyingRemotePlayback=false;
let lastPlaybackSignature="";

function getPlayerPosition(){
  try{return ytReady&&ytPlayer ? Number(ytPlayer.getCurrentTime()||0) : 0;}
  catch(e){return 0;}
}

async function hostSetPlayback(state, position=null){
  if(!isHost || !db || !roomCode) return;
  const pos = position===null ? getPlayerPosition() : Number(position||0);
  await set(ref(db,`rooms/${roomCode}/meta/playback`),{
    state,
    position:pos,
    updatedAt:Date.now()
  });
}

function desiredPlaybackPosition(pb){
  if(!pb) return 0;
  let pos=Number(pb.position||0);
  if(pb.state==="playing" && pb.updatedAt){
    pos += Math.max(0,(Date.now()-Number(pb.updatedAt))/1000);
  }
  return pos;
}

function applyRemotePlayback(pb){
  if(!pb || !ytReady || !ytPlayer || !currentQuestion) return;

  const sig=`${pb.state}|${Math.round(Number(pb.position||0)*10)}|${pb.updatedAt||0}`;
  if(sig===lastPlaybackSignature) return;
  lastPlaybackSignature=sig;

  applyingRemotePlayback=true;
  try{
    const target=desiredPlaybackPosition(pb);
    const current=Number(ytPlayer.getCurrentTime()||0);
    if(Math.abs(current-target)>1.5){
      ytPlayer.seekTo(target,true);
    }
    if(pb.state==="playing"){
      ytPlayer.playVideo();
      $("#playerStatus").textContent=isHost?"재생 중":"호스트와 동기화 · 재생 중";
    }else{
      ytPlayer.pauseVideo();
      $("#playerStatus").textContent=isHost?"일시정지":"호스트와 동기화 · 일시정지";
    }
  }catch(e){
    console.warn("[EROGE MP] playback sync failed",e);
  }finally{
    setTimeout(()=>{applyingRemotePlayback=false;},150);
  }
}

function applyHostControlUI(){
  const locked=!isHost;
  $("#audioPlay").disabled=locked;
  $("#audioPause").disabled=locked;
  $("#audioRestart").disabled=locked;
  $("#playerTools").classList.toggle("participant-locked",locked);
  if(locked){
    $("#audioPlay").title="영상 재생은 호스트가 제어합니다.";
    $("#audioPause").title="영상 재생은 호스트가 제어합니다.";
    $("#audioRestart").title="영상 재생은 호스트가 제어합니다.";
  }
}

// 관리자 정답 팝업: 호스트 전용
let adminWindow=null;
const ADMIN_PASSWORD="1234";

function adminData(){
  if(!currentQuestion || !roomState) return null;
  return {
    progress:`${Number(roomState.questionIndex||0)+1} / ${roomState.order?.length||0}`,
    game:currentQuestion.game||currentQuestion.anime||"-",
    song:currentQuestion.song||"-",
    type:currentQuestion.type||"-",
    vocal:currentQuestion.vocal||"-",
    year:currentQuestion.year||"-",
    videoId:candidateIds[candidateIndex]||currentQuestion.videoId||"-"
  };
}
function adminEsc(v){
  return String(v??"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;");
}
function renderAdminWindow(){
  if(!isHost || !adminWindow || adminWindow.closed) return;
  const a=adminData();
  const body=a?`
    <div class="badge">${adminEsc(a.progress)}</div>
    <h2>${adminEsc(a.game)}</h2>
    <dl>
      <dt>곡 제목</dt><dd>${adminEsc(a.song)}</dd>
      <dt>구분</dt><dd>${adminEsc(a.type)}</dd>
      <dt>보컬</dt><dd>${adminEsc(a.vocal)}</dd>
      <dt>연도</dt><dd>${adminEsc(a.year)}</dd>
      <dt>YouTube ID</dt><dd class="mono">${adminEsc(a.videoId)}</dd>
    </dl>`:`<p>현재 문제가 없습니다.</p>`;
  adminWindow.document.open();
  adminWindow.document.write(`<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>EROGE SONG QUIZ ADMIN</title>
  <style>*{box-sizing:border-box}body{margin:0;padding:18px;background:#0f1115;color:#f4f5f7;font-family:system-ui,-apple-system,"Noto Sans KR",sans-serif}.head{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px}.head h1{font-size:17px;margin:0}.live{font-size:11px;color:#7ce5c6}.badge{display:inline-block;padding:5px 9px;border-radius:999px;background:#26322f;color:#7ce5c6;font-size:12px;font-weight:800;margin-bottom:12px}h2{font-size:20px;line-height:1.35;margin:0 0 18px}dl{margin:0}dt{font-size:11px;color:#8e97a5;margin-top:12px}dd{font-size:16px;font-weight:800;margin:3px 0 0;word-break:break-word}.mono{font-family:Consolas,monospace;font-size:13px;color:#b9c0ca}.tip{margin-top:22px;padding-top:12px;border-top:1px solid #2a3038;color:#6f7885;font-size:11px}</style>
  </head><body><div class="head"><h1>EROGE SONG QUIZ · 관리자 정답</h1><span class="live">HOST</span></div>${body}<div class="tip">다음 문제로 이동하면 자동 갱신됩니다.</div></body></html>`);
  adminWindow.document.close();
}
function openAdminWindow(){
  if(!isHost) return;
  const pw=prompt("관리자 비밀번호를 입력하세요.");
  if(pw===null) return;
  if(pw!==ADMIN_PASSWORD){alert("비밀번호가 올바르지 않습니다.");return;}
  if(!adminWindow || adminWindow.closed){
    adminWindow=window.open("","EROGE_MP_ADMIN","popup=yes,width=430,height=520,resizable=yes,scrollbars=yes");
  }
  if(!adminWindow){alert("팝업이 차단되었습니다. 이 사이트의 팝업을 허용해주세요.");return;}
  renderAdminWindow();
  adminWindow.focus();
}
document.addEventListener("keydown",e=>{
  if(isHost && e.ctrlKey && e.shiftKey && (e.key==="A"||e.key==="a")){
    e.preventDefault();
    openAdminWindow();
  }
});


function registerDisconnectCleanup(){
  if(!db || !roomCode || !playerId) return;

  const playerRef=ref(db,`rooms/${roomCode}/players/${playerId}`);
  const leaveEventRef=push(ref(db,`rooms/${roomCode}/events`));

  // Firebase 서버가 연결 종료를 감지하면 참가자 행을 실제로 삭제한다.
  // 탭 닫기 / 브라우저 종료 / 네트워크 단절에도 동작한다.
  onDisconnect(playerRef).remove();

  // 같은 disconnect 시점에 퇴장 메시지도 서버에서 기록한다.
  onDisconnect(leaveEventRef).set({
    text:`${nickname}님이 퇴장했습니다.`,
    type:"system",
    at:serverTimestamp()
  });
}

function enterRoom(){
  $("#setup").hidden=true; $("#game").hidden=false; $("#roomHead").hidden=false;
  $("#roomCodeLabel").textContent=roomCode;
  $("#nicknameLabel").textContent=nickname;
  $("#hostBadge").hidden=!isHost;
  $("#hostControls").hidden=!isHost;
  registerDisconnectCleanup();
  applyHostControlUI();

  const pref=ref(db,`rooms/${roomCode}/players/${playerId}`);
  

  roomUnsub=onValue(ref(db,`rooms/${roomCode}/meta`),snap=>{
    if(!snap.exists()){alert("방이 종료되었습니다.");location.reload();return;}
    const prevToken=roomState?.questionToken;
    roomState=snap.val();
    if(roomState.status==="finished"){showComplete();return;}
    if(prevToken!==roomState.questionToken)loadRoomQuestion();
    else renderSolvedState();
    applyRemotePlayback(roomState.playback);
    renderAdminWindow();
  });

  playersUnsub=onValue(ref(db,`rooms/${roomCode}/players`),snap=>{
    playerState=snap.val()||{};
    renderPlayers();
  });

  eventsUnsub=onValue(ref(db,`rooms/${roomCode}/events`),snap=>{
    renderEvents(snap.val()||{});
  });

  injectYouTubeAPI();
}

function getRoomQuestion(){
  if(!roomState?.order?.length)return null;
  const qi=Number(roomState.questionIndex||0);
  const dataIndex=Number(roomState.order[qi]);
  return quizData.find(x=>x.__index===dataIndex)||quizData[dataIndex]||null;
}

function loadRoomQuestion(){
  currentQuestion=getRoomQuestion();
  if(!currentQuestion)return;

  const total=roomState.order.length;
  $("#progress").textContent=`${Number(roomState.questionIndex)+1} / ${total}`;
  $("#type").textContent=currentQuestion.type||"SONG";
  $("#yearBadge").textContent=currentQuestion.year||"";
  $("#gameInput").value=""; $("#songInput").value="";
  hideSuggestions("game");hideSuggestions("song");
  $("#publicAnswer").hidden=true;
  $("#answerPlaceholder").hidden=false;
  $("#videoCurtain").hidden=false;

  setupCandidates(currentQuestion);
  cueCurrentCandidate();
  renderSolvedState();
  renderAdminWindow();
}

function renderSolvedState(){
  if(!roomState||!currentQuestion)return;
  const gs=roomState.gameSolvedBy;
  const ss=roomState.songSolvedBy;
  const forced=!!roomState.forcedReveal;

  $("#gameAnswerGroup").classList.toggle("solved",!!gs||forced);
  $("#songAnswerGroup").classList.toggle("solved",!!ss||forced);
  $("#gameInput").disabled=!!gs||forced;
  $("#songInput").disabled=!!ss||forced;
  $("#submitGame").disabled=!!gs||forced;
  $("#submitSong").disabled=!!ss||forced;

  $("#gameLockStatus").textContent=gs?`${gs.nickname} 정답!`:forced?"공개됨":"+1점";
  $("#songLockStatus").textContent=ss?`${ss.nickname} 정답!`:forced?"공개됨":"+1점";

  if(gs||ss||forced){
    $("#publicAnswer").hidden=false;
    $("#answerPlaceholder").hidden=true;
    $("#answerGame").textContent=(gs||forced)?currentQuestion.game:"???";
    $("#answerSong").textContent=(ss||forced)?currentQuestion.song:"???";
    $("#answerVocal").textContent=(ss||forced)?(currentQuestion.vocal||"-"):"???";
    $("#answerYear").textContent=(gs||forced)?(currentQuestion.year||"-"):"???";
    setImage((gs&&ss)||forced ? currentQuestion.image : "");
  }else{
    $("#publicAnswer").hidden=true;
    $("#answerPlaceholder").hidden=false;
  }

  // 영상은 둘 다 맞혀졌거나 방장이 강제 공개했을 때만 공개
  $("#videoCurtain").hidden=!!((gs&&ss)||forced);
}

function setImage(url){
  const img=$("#answerImage"), fb=$("#imageFallback");
  if(url){
    img.hidden=false;fb.hidden=true;img.src=url;
    img.onerror=()=>{img.hidden=true;fb.hidden=false;};
  }else{img.hidden=true;fb.hidden=false;img.removeAttribute("src");}
}

async function submitAnswer(kind){
  if(!roomState||!currentQuestion)return;
  const solvedKey=kind==="game"?"gameSolvedBy":"songSolvedBy";
  if(roomState[solvedKey]||roomState.forcedReveal)return;

  const input=kind==="game"?$("#gameInput"):$("#songInput");
  const answer=kind==="game"?currentQuestion.game:currentQuestion.song;
  if(norm(input.value)!==norm(answer))return;

  // 서버 트랜잭션으로 "최초 정답자 1명"만 확정한다.
  const solveRef=ref(db,`rooms/${roomCode}/meta/${solvedKey}`);
  const tx=await runTransaction(solveRef,current=>{
    if(current)return; // someone already won this answer
    return {playerId,nickname,at:Date.now()};
  });

  if(tx.committed && tx.snapshot.val()?.playerId===playerId){
    await runTransaction(ref(db,`rooms/${roomCode}/players/${playerId}/score`),s=>Number(s||0)+1);
    await addEvent(`${nickname}님이 ${kind==="game"?"작품":"곡"} 정답!  ${answer}`,"correct");
  }
}

function sourceValues(kind){
  return uniq(quizData.map(x=>kind==="game"?x.game:x.song));
}
function updateSuggestions(kind){
  const input=kind==="game"?$("#gameInput"):$("#songInput");
  const box=kind==="game"?$("#gameSuggestions"):$("#songSuggestions");
  const raw=input.value.trim();
  if(raw.length<2){hideSuggestions(kind);return;}
  const n=norm(raw);
  const matches=sourceValues(kind).filter(v=>norm(v).includes(n)).slice(0,12);
  if(!matches.length){hideSuggestions(kind);return;}
  box.innerHTML="";
  for(const value of matches){
    const b=document.createElement("button");b.type="button";b.className="suggestion-item";b.textContent=value;
    b.onclick=()=>{input.value=value;hideSuggestions(kind);input.focus();};
    box.appendChild(b);
  }
  box.hidden=false;
}
function hideSuggestions(kind){
  const box=kind==="game"?$("#gameSuggestions"):$("#songSuggestions");
  box.hidden=true;box.innerHTML="";
}

async function hostReveal(){
  if(!isHost)return;
  await update(ref(db,`rooms/${roomCode}/meta`),{forcedReveal:true});
  await addEvent("방장이 정답을 공개했습니다.","system");
}
async function hostNext(){
  if(!isHost)return;
  const next=Number(roomState.questionIndex||0)+1;
  if(next>=roomState.order.length){
    await update(ref(db,`rooms/${roomCode}/meta`),{status:"finished"});
    await addEvent("퀴즈가 종료되었습니다.","system");
    return;
  }
  await update(ref(db,`rooms/${roomCode}/meta`),{
    questionIndex:next,questionToken:Number(roomState.questionToken||0)+1,
    gameSolvedBy:null,songSolvedBy:null,forcedReveal:false,
    playback:{state:"playing",position:0,updatedAt:Date.now()}
  });
  await addEvent(`${next+1}번 문제 시작!`,"system");
}

function renderPlayers(){
  const arr=Object.entries(playerState).map(([id,p])=>({id,...p})).sort((a,b)=>(b.score||0)-(a.score||0));
  $("#playerCount").textContent=arr.length;
  $("#players").innerHTML=arr.map((p,i)=>`
    <div class="player-row ${p.id===playerId?"me":""}">
      <span>●</span>
      <span>${esc(p.nickname)} ${p.id===roomState?.hostId?'<em class="hostmark">HOST</em>':""}</span>
      <b>${p.score||0}</b>
    </div>`).join("");
  $("#ranking").innerHTML=arr.slice(0,10).map((p,i)=>`
    <div class="rank-row ${p.id===playerId?"me":""}">
      <b>${i+1}</b><span>${esc(p.nickname)}</span><b>${p.score||0}</b>
    </div>`).join("");
  $("#myScoreLabel").textContent=playerState[playerId]?.score||0;
}
function renderEvents(obj){
  const arr=Object.values(obj).sort((a,b)=>(a.at||0)-(b.at||0)).slice(-50);
  $("#events").innerHTML=arr.map(e=>`<div class="event ${e.type||"system"}">${esc(e.text)}</div>`).join("");
  $("#events").scrollTop=$("#events").scrollHeight;
}
function showComplete(){
  $("#game").hidden=true;$("#complete").hidden=false;
  const arr=Object.entries(playerState).map(([id,p])=>({id,...p})).sort((a,b)=>(b.score||0)-(a.score||0));
  $("#finalRanking").innerHTML=arr.map((p,i)=>`
    <div class="rank-row ${p.id===playerId?"me":""}">
      <b>${i+1}</b><span>${esc(p.nickname)}</span><b>${p.score||0}점</b>
    </div>`).join("");
  if(ytReady&&ytPlayer)try{ytPlayer.pauseVideo()}catch(e){}
}

// YouTube player
function injectYouTubeAPI(){
  if(apiLoaded)return;apiLoaded=true;
  window.onYouTubeIframeAPIReady=()=>{
    ytPlayer=new YT.Player("player",{
      width:"100%",height:"100%",videoId:"",
      playerVars:{controls:1,rel:0,playsinline:1,fs:1,origin:location.origin},
      events:{
        onReady:()=>{
          ytReady=true;
          ytPlayer.setVolume(Number($("#volume").value)||70);
          if(currentQuestion)cueCurrentCandidate();
          if(roomState?.playback) setTimeout(()=>applyRemotePlayback(roomState.playback),250);
        },
        onStateChange:e=>{
          if(e.data===YT.PlayerState.PLAYING){
            $("#playerStatus").textContent=isHost?"재생 중":"호스트와 동기화 · 재생 중";
            if(isHost && !applyingRemotePlayback) hostSetPlayback("playing");
          }else if(e.data===YT.PlayerState.PAUSED){
            $("#playerStatus").textContent=isHost?"일시정지":"호스트와 동기화 · 일시정지";
            if(isHost && !applyingRemotePlayback) hostSetPlayback("paused");
          }else if(e.data===YT.PlayerState.BUFFERING){
            $("#playerStatus").textContent="버퍼링 중...";
          }
        },
        onError:e=>{
          if([100,101,150].includes(e.data)&&candidateIndex+1<candidateIds.length){
            candidateIndex++;setTimeout(cueCurrentCandidate,250);
          }else $("#playerStatus").textContent=`YouTube 오류 ${e.data}`;
        },
        onAutoplayBlocked:()=>$("#playerStatus").textContent="자동재생 차단 · 재생 버튼을 눌러주세요"
      }
    });
  };
  const s=document.createElement("script");s.src="https://www.youtube.com/iframe_api";document.head.appendChild(s);
}
function setupCandidates(q){
  candidateIds=uniq((q.videoIds&&q.videoIds.length)?q.videoIds:(q.videoId?[q.videoId]:[]));candidateIndex=0;
  $("#candidateText").textContent=`후보 ${candidateIds.length}개`;
}
function cueCurrentCandidate(){
  if(!ytReady||!ytPlayer||!candidateIds.length)return;
  $("#candidateText").textContent=`후보 ${candidateIndex+1}/${candidateIds.length}`;
  ytPlayer.loadVideoById({videoId:candidateIds[candidateIndex],startSeconds:0});
  ytPlayer.setVolume(Number($("#volume").value)||70);
  setTimeout(()=>{
    if(roomState?.playback) applyRemotePlayback(roomState.playback);
  },300);
}

$("#audioPlay").onclick=async()=>{
  if(!isHost || !ytReady)return;
  ytPlayer.playVideo();
  await hostSetPlayback("playing");
};
$("#audioPause").onclick=async()=>{
  if(!isHost || !ytReady)return;
  ytPlayer.pauseVideo();
  await hostSetPlayback("paused");
};
$("#audioRestart").onclick=async()=>{
  if(!isHost || !ytReady)return;
  ytPlayer.seekTo(0,true);
  ytPlayer.playVideo();
  await hostSetPlayback("playing",0);
};
$("#volume").oninput=e=>{
  if(ytReady)ytPlayer.setVolume(Number(e.target.value));
};

$("#createRoom").onclick=async()=>{
  const btn=$("#createRoom");
  const old=btn.textContent;
  btn.disabled=true;
  btn.textContent="방 생성 중...";
  try{
    await createRoom();
  }catch(e){
    console.error("[EROGE MP] createRoom failed:",e);
    alert(`방 생성 실패\n${e.message || e}`);
  }finally{
    btn.disabled=false;
    btn.textContent=old;
  }
};

$("#joinRoom").onclick=async()=>{
  const btn=$("#joinRoom");
  const old=btn.textContent;
  btn.disabled=true;
  btn.textContent="참가 중...";
  try{
    await joinRoom();
  }catch(e){
    console.error("[EROGE MP] joinRoom failed:",e);
    alert(`방 참가 실패\n${e.message || e}`);
  }finally{
    btn.disabled=false;
    btn.textContent=old;
  }
};
$("#submitGame").onclick=()=>submitAnswer("game");
$("#submitSong").onclick=()=>submitAnswer("song");
$("#gameInput").oninput=()=>updateSuggestions("game");
$("#songInput").oninput=()=>updateSuggestions("song");
$("#gameInput").onkeydown=e=>{if(e.key==="Enter")submitAnswer("game");};
$("#songInput").onkeydown=e=>{if(e.key==="Enter")submitAnswer("song");};
$("#hostReveal").onclick=hostReveal;
$("#hostNext").onclick=hostNext;
document.addEventListener("click",e=>{
  if(!e.target.closest(".autocomplete-wrap")){hideSuggestions("game");hideSuggestions("song");}
});

(async()=>{
  try{
    const firebaseOK=initFirebase();
    await loadQuiz();
    if(!firebaseOK){
      console.warn("[EROGE MP] Quiz loaded but Firebase is not ready.");
    }
    console.log("[EROGE MP] quiz rows:",quizData.length);
  }catch(e){
    console.error("[EROGE MP] startup error:",e);
    $("#firebaseWarning").hidden=false;
    $("#firebaseWarning").textContent=`초기화 오류: ${e.message}`;
  }
})();
