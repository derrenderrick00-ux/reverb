const $ = id => document.getElementById(id);
const fileInput = $('fileInput');
const dropZone = $('dropZone');
const audioContextClass = window.AudioContext || window.webkitAudioContext;
let audioContext = null;
let buffer = null;
let source = null;
let gainNode = null;
let panner = null;
let convolver = null;
let wetGain = null;
let dryGain = null;
let impulseBuffer = null;
let isPlaying = false;
let startedAt = 0;
let pausedAt = 0;
let animationFrame = 0;
let selectedMode = 'smooth';
let roomEnabled = false;
let objectUrl = null;
let exportBusy = false;
let currentFileName = 'reverb-mix';

function getContext(){
  if(!audioContext) audioContext = new audioContextClass();
  return audioContext;
}

function showToast(message){
  const toast = $('toast');
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(()=>toast.classList.remove('show'),2800);
}

function formatTime(seconds){
  if(!Number.isFinite(seconds)) return '00:00';
  const s = Math.max(0,Math.floor(seconds));
  return `${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;
}

function makeImpulse(ctx, seconds=1.6, decay=2.5){
  const length = Math.floor(ctx.sampleRate*seconds);
  const impulse = ctx.createBuffer(2,length,ctx.sampleRate);
  for(let channel=0;channel<2;channel++){
    const data = impulse.getChannelData(channel);
    for(let i=0;i<length;i++) data[i]=(Math.random()*2-1)*Math.pow(1-i/length,decay);
  }
  return impulse;
}

function ensureGraph(){
  const ctx = getContext();
  if(!panner){
    panner = ctx.createStereoPanner();
    gainNode = ctx.createGain();
    dryGain = ctx.createGain();
    wetGain = ctx.createGain();
    convolver = ctx.createConvolver();
    impulseBuffer = makeImpulse(ctx);
    convolver.buffer = impulseBuffer;
    dryGain.gain.value = 1;
    wetGain.gain.value = 0;
    panner.connect(dryGain);
    dryGain.connect(gainNode);
    panner.connect(convolver);
    convolver.connect(wetGain);
    wetGain.connect(gainNode);
    gainNode.connect(ctx.destination);
  }
}

function getElapsed(){
  if(!isPlaying) return pausedAt;
  return Math.min(buffer.duration,pausedAt+(getContext().currentTime-startedAt));
}

function getPanAt(time){
  const speed = Number($('speed').value);
  const width = Number($('width').value)/100;
  const phase = time*speed*Math.PI*2;
  const wave = selectedMode==='smooth' ? Math.sin(phase) : Math.tanh(2.2*Math.sin(phase))/Math.tanh(2.2);
  return Math.max(-1,Math.min(1,wave*width));
}

function schedulePanning(node, startTime, offset, duration){
  const speed = Number($('speed').value);
  const width = Number($('width').value)/100;
  const step = 0.025;
  const count = Math.ceil(duration/step);
  node.pan.cancelScheduledValues(startTime);
  node.pan.setValueAtTime(getPanAt(offset),startTime);
  for(let i=1;i<=count;i++){
    const elapsed = Math.min(duration,i*step);
    const phase = (offset+elapsed)*speed*Math.PI*2;
    const wave = selectedMode==='smooth' ? Math.sin(phase) : Math.tanh(2.2*Math.sin(phase))/Math.tanh(2.2);
    node.pan.linearRampToValueAtTime(Math.max(-1,Math.min(1,wave*width)),startTime+elapsed);
  }
}

async function loadFile(file){
  if(!file) return;
  if(!file.type.startsWith('audio/') && !/\.(mp3|wav|m4a|ogg|aac|flac|webm)$/i.test(file.name)){
    showToast('Choose an audio file to get started.');
    return;
  }
  try{
    $('transportTitle').textContent='Loading your track…';
    const ctx = getContext();
    if(ctx.state==='suspended') await ctx.resume();
    const data = await file.arrayBuffer();
    const decoded = await ctx.decodeAudioData(data.slice(0));
    stopPlayback();
    buffer = decoded;
    currentFileName = file.name.replace(/\.[^.]+$/,'').replace(/[^\w\-]+/g,'-').replace(/^-|-$/g,'') || 'reverb-mix';
    $('fileName').textContent=file.name;
    $('fileMeta').textContent=`${decoded.numberOfChannels===1?'MONO':'STEREO'}  ·  ${(decoded.sampleRate/1000).toFixed(1)} KHZ  ·  ${formatTime(decoded.duration)}`;
    $('duration').textContent=formatTime(decoded.duration);
    $('currentTime').textContent='00:00';
    $('trackInfo').classList.add('visible');
    dropZone.style.display='none';
    $('playBtn').disabled=false;
    $('exportBtn').disabled=false;
    $('transportTitle').textContent='Ready when you are';
    $('transportSub').textContent='Press play to preview the moving mix.';
    drawWaveform(decoded);
    updatePlayhead();
    showToast('Track loaded. Put your headphones on.');
  }catch(error){
    $('transportTitle').textContent='Could not open this file';
    showToast('This audio format could not be decoded by your browser. Try MP3 or WAV.');
  }
}

function drawWaveform(audioBuffer){
  const canvas=$('waveCanvas');
  const rect=canvas.getBoundingClientRect();
  const dpr=window.devicePixelRatio||1;
  canvas.width=Math.max(1,Math.floor(rect.width*dpr));
  canvas.height=Math.max(1,Math.floor(rect.height*dpr));
  const ctx=canvas.getContext('2d');
  ctx.scale(dpr,dpr);
  const w=rect.width,h=rect.height;
  ctx.clearRect(0,0,w,h);
  const data=audioBuffer.getChannelData(0);
  const step=Math.max(1,Math.floor(data.length/w/2));
  const amp=h*.38;
  ctx.strokeStyle='#a5aa96';
  ctx.lineWidth=1.35;
  ctx.beginPath();
  for(let x=0;x<w;x++){
    const start=x*step*2;
    let min=1,max=-1;
    for(let j=0;j<step;j++){
      const value=data[start+j]||0;
      if(value<min)min=value;
      if(value>max)max=value;
    }
    ctx.moveTo(x,h/2+min*amp);
    ctx.lineTo(x,h/2+max*amp);
  }
  ctx.stroke();
  ctx.strokeStyle='#d5d6cc';
  ctx.beginPath();ctx.moveTo(0,h/2);ctx.lineTo(w,h/2);ctx.stroke();
}

function stopSourceOnly(){
  if(source){
    try{source.onended=null;source.stop()}catch(e){}
    try{source.disconnect()}catch(e){}
    source=null;
  }
}

async function playPlayback(){
  if(!buffer) return;
  const ctx=getContext();
  await ctx.resume();
  if(pausedAt>=buffer.duration) pausedAt=0;
  stopSourceOnly();
  ensureGraph();
  source=ctx.createBufferSource();
  source.buffer=buffer;
  source.connect(panner);
  const now=ctx.currentTime;
  const duration=buffer.duration-pausedAt;
  schedulePanning(panner,now,pausedAt,duration);
  gainNode.gain.setTargetAtTime(Number($('level').value)/100,now,.025);
  wetGain.gain.setTargetAtTime(roomEnabled?.22:0,now,.04);
  source.start(now,pausedAt);
  startedAt=now;
  isPlaying=true;
  source.onended=()=>{
    if(isPlaying && getElapsed()>=buffer.duration-.05){
      isPlaying=false;pausedAt=0;source=null;
      updateTransport();
      updatePlayhead();
    }
  };
  updateTransport();
  tick();
}

function pausePlayback(){
  if(isPlaying){
    pausedAt=getElapsed();
    isPlaying=false;
    stopSourceOnly();
    updateTransport();
    cancelAnimationFrame(animationFrame);
    updatePlayhead();
  }
}

function stopPlayback(){
  isPlaying=false;
  pausedAt=0;
  stopSourceOnly();
  cancelAnimationFrame(animationFrame);
  updateTransport();
  updatePlayhead();
}

async function togglePlayback(){
  if(!buffer) return;
  if(isPlaying) pausePlayback();
  else await playPlayback();
}

function updateTransport(){
  const icon=$('playIcon');
  if(isPlaying){
    icon.innerHTML='<path d="M7 5h4v14H7zM15 5h4v14h-4z"/>';
    $('transportTitle').textContent='Playing your moving mix';
    $('transportSub').textContent='Live stereo processing is active.';
    $('meter').classList.add('active');
  }else{
    icon.innerHTML='<path d="M8 5v14l11-7z"/>';
    $('transportTitle').textContent=buffer?'Ready to preview':'Nothing playing yet';
    $('transportSub').textContent=buffer?'Your settings apply as you listen.':'Upload a track to begin shaping the sound.';
    $('meter').classList.remove('active');
  }
}

function updatePlayhead(){
  if(!buffer) return;
  const elapsed=getElapsed();
  $('currentTime').textContent=formatTime(elapsed);
  $('playhead').style.left=`${Math.min(100,elapsed/buffer.duration*100)}%`;
}

function tick(){
  if(!isPlaying)return;
  updatePlayhead();
  animationFrame=requestAnimationFrame(tick);
}

function updateControls(){
  $('speedValue').textContent=`${Number($('speed').value).toFixed(2)} Hz`;
  $('widthValue').textContent=`${$('width').value}%`;
  $('levelValue').textContent=`${$('level').value}%`;
  if(isPlaying && panner){
    const now=getContext().currentTime;
    schedulePanning(panner,now,getElapsed(),Math.max(.2,buffer.duration-getElapsed()));
    gainNode.gain.setTargetAtTime(Number($('level').value)/100,now,.025);
  }
}

function toggleRoom(){
  roomEnabled=!roomEnabled;
  $('reverbToggle').classList.toggle('on',roomEnabled);
  $('reverbToggle').setAttribute('aria-checked',String(roomEnabled));
  if(wetGain && audioContext) wetGain.gain.setTargetAtTime(roomEnabled?.22:0,audioContext.currentTime,.04);
}

function audioBufferToWav(audioBuffer){
  const channels=audioBuffer.numberOfChannels;
  const sampleRate=audioBuffer.sampleRate;
  const frames=audioBuffer.length;
  const bytesPerSample=2;
  const blockAlign=channels*bytesPerSample;
  const dataSize=frames*blockAlign;
  const arrayBuffer=new ArrayBuffer(44+dataSize);
  const view=new DataView(arrayBuffer);
  const writeString=(offset,string)=>{for(let i=0;i<string.length;i++)view.setUint8(offset+i,string.charCodeAt(i));};
  writeString(0,'RIFF');
  view.setUint32(4,36+dataSize,true);
  writeString(8,'WAVE');
  writeString(12,'fmt ');
  view.setUint32(16,16,true);
  view.setUint16(20,1,true);
  view.setUint16(22,channels,true);
  view.setUint32(24,sampleRate,true);
  view.setUint32(28,sampleRate*blockAlign,true);
  view.setUint16(32,blockAlign,true);
  view.setUint16(34,16,true);
  writeString(36,'data');
  view.setUint32(40,dataSize,true);
  const channelData=Array.from({length:channels},(_,i)=>audioBuffer.getChannelData(i));
  let offset=44;
  for(let i=0;i<frames;i++){
    for(let channel=0;channel<channels;channel++){
      let sample=Math.max(-1,Math.min(1,channelData[channel][i]));
      sample=sample<0?sample*32768:sample*32767;
      view.setInt16(offset,sample,true);
      offset+=2;
    }
  }
  return new Blob([arrayBuffer],{type:'audio/wav'});
}

async function exportAudio(){
  if(!buffer||exportBusy)return;
  exportBusy=true;
  $('exportBtn').disabled=true;
  $('exportLabel').textContent='Rendering your mix…';
  try{
    const offline=new OfflineAudioContext(2,Math.ceil((buffer.duration+(roomEnabled?1.6:0))*buffer.sampleRate),buffer.sampleRate);
    const offlineSource=offline.createBufferSource();
    offlineSource.buffer=buffer;
    const offlinePanner=offline.createStereoPanner();
    const offlineGain=offline.createGain();
    offlineGain.gain.value=Number($('level').value)/100;
    offlineSource.connect(offlinePanner);
    if(roomEnabled){
      const offlineConvolver=offline.createConvolver();
      const offlineWet=offline.createGain();
      const offlineDry=offline.createGain();
      const impulse=makeImpulse(offline,1.6,2.5);
      offlineConvolver.buffer=impulse;
      offlineDry.gain.value=1;
      offlineWet.gain.value=.22;
      offlinePanner.connect(offlineDry);
      offlineDry.connect(offlineGain);
      offlinePanner.connect(offlineConvolver);
      offlineConvolver.connect(offlineWet);
      offlineWet.connect(offlineGain);
      offlineGain.connect(offline.destination);
    }else{
      offlinePanner.connect(offlineGain);
      offlineGain.connect(offline.destination);
    }
    const speed=Number($('speed').value);
    const width=Number($('width').value)/100;
    const duration=buffer.duration;
    const step=.02;
    offlinePanner.pan.setValueAtTime(getPanAt(0),0);
    for(let t=step;t<duration;t+=step){
      const phase=t*speed*Math.PI*2;
      const wave=selectedMode==='smooth'?Math.sin(phase):Math.tanh(2.2*Math.sin(phase))/Math.tanh(2.2);
      offlinePanner.pan.linearRampToValueAtTime(Math.max(-1,Math.min(1,wave*width)),t);
    }
    const finalPhase=duration*speed*Math.PI*2;
    const finalWave=selectedMode==='smooth'?Math.sin(finalPhase):Math.tanh(2.2*Math.sin(finalPhase))/Math.tanh(2.2);
    offlinePanner.pan.linearRampToValueAtTime(Math.max(-1,Math.min(1,finalWave*width)),duration);
    offlineSource.start(0);
    const rendered=await offline.startRendering();
    const wav=audioBufferToWav(rendered);
    const url=URL.createObjectURL(wav);
    const link=document.createElement('a');
    link.href=url;
    link.download=`${currentFileName}-reverb.wav`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(()=>URL.revokeObjectURL(url),30000);
    showToast('Your processed WAV is ready.');
  }catch(error){
    showToast('Export failed. Try a shorter track or a WAV file.');
  }finally{
    exportBusy=false;
    $('exportBtn').disabled=!buffer;
    $('exportLabel').textContent='Export processed WAV';
  }
}

$('chooseBtn').addEventListener('click',()=>fileInput.click());
$('replaceBtn').addEventListener('click',()=>fileInput.click());
fileInput.addEventListener('change',event=>{if(event.target.files[0])loadFile(event.target.files[0]);event.target.value='';});
$('playBtn').addEventListener('click',togglePlayback);
$('exportBtn').addEventListener('click',exportAudio);
$('reverbToggle').addEventListener('click',toggleRoom);
['speed','width','level'].forEach(id=>$(id).addEventListener('input',updateControls));
document.querySelectorAll('.mode-btn').forEach(button=>button.addEventListener('click',()=>{
  document.querySelectorAll('.mode-btn').forEach(item=>item.classList.remove('active'));
  button.classList.add('active');
  selectedMode=button.dataset.mode;
  $('modeValue').textContent=selectedMode==='smooth'?'Smooth':'Wide sweep';
  updateControls();
}));
['dragover','dragenter'].forEach(name=>dropZone.addEventListener(name,event=>{event.preventDefault();dropZone.classList.add('dragging');}));
['dragleave','drop'].forEach(name=>dropZone.addEventListener(name,event=>{event.preventDefault();dropZone.classList.remove('dragging');}));
dropZone.addEventListener('drop',event=>{const file=event.dataTransfer.files[0];if(file)loadFile(file);});
window.addEventListener('resize',()=>{if(buffer)drawWaveform(buffer);});
document.addEventListener('visibilitychange',()=>{if(document.hidden&&isPlaying)pausePlayback();});
updateControls();