"use strict";
document.getElementById('save').addEventListener('click',async()=>{
  const key=document.getElementById('key').value.trim();
  if(key.length<35){document.getElementById('status').textContent='Ogiltig kod';return;}
  await chrome.storage.local.set({pairing:key});
  document.getElementById('key').value='';
  document.getElementById('status').textContent='Kod sparad lokalt. Gå till Omega och skriv /browser status.';
});
