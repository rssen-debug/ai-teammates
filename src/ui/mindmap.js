/* MAJIN inline mindmap: explicit user-visible outline => SVG, never fabricated agent thoughts. */
(function(){
'use strict';
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function render(raw){
  const lines=String(raw).replace(/\r/g,'').split('\n').filter(x=>x.trim()).slice(0,32);
  if(!lines.length)return '<div class="majin-mindmap-empty">Empty mindmap</div>';
  const nodes=[];const last=[];
  for(const line of lines){
    const spaces=(line.match(/^\s*/)||[''])[0].replace(/\t/g,'  ').length;
    const level=Math.min(4,Math.floor(spaces/2));
    const label=line.trim().replace(/^[-*+]\s*/,'').slice(0,68);
    if(!label)continue;
    const parent=level>0?last[level-1]:null;
    const id=nodes.length;nodes.push({id,label,level,parent:parent===undefined?null:parent,x:0,y:0});
    last[level]=id;last.length=level+1;
  }
  if(!nodes.length)return '<div class="majin-mindmap-empty">Empty mindmap</div>';
  const countByLevel=new Map();
  for(const n of nodes){n.x=20+n.level*195;n.y=24+(countByLevel.get(n.level)||0)*86;countByLevel.set(n.level,(countByLevel.get(n.level)||0)+1);}
  const width=Math.max(400,Math.max(...nodes.map(n=>n.x))+183);
  const height=Math.max(145,Math.max(...nodes.map(n=>n.y))+80);
  const edges=nodes.filter(n=>n.parent!=null).map(n=>{const p=nodes[n.parent];return '<path d="M'+(p.x+166)+' '+(p.y+22)+' C'+(p.x+184)+' '+(p.y+22)+','+(n.x-14)+' '+(n.y+22)+','+n.x+' '+(n.y+22)+'" fill="none" stroke="#ec83cb" stroke-opacity=".58" stroke-width="2"/>';}).join('');
  const shapes=nodes.map(n=>'<g><rect x="'+n.x+'" y="'+n.y+'" width="166" height="45" rx="15" fill="'+(n.level===0?'#3d173c':'#241426')+'" stroke="'+(n.level===0?'#ffaddd':'#a55296')+'" stroke-width="1.4"/><text x="'+(n.x+12)+'" y="'+(n.y+27)+'" font-size="12" fill="#ffe5f4" font-family="Inter,Segoe UI,sans-serif">'+esc(n.label.length>22?n.label.slice(0,21)+'…':n.label)+'</text><title>'+esc(n.label)+'</title></g>').join('');
  return '<div class="majin-mindmap" role="group" aria-label="Mindmap"><div class="majin-mindmap-title">MAJIN / MINDMAP</div><div class="majin-mindmap-scroll" tabindex="0"><svg role="img" aria-label="'+esc(nodes[0].label)+' mindmap" viewBox="0 0 '+width+' '+height+'" width="'+width+'" height="'+height+'" xmlns="http://www.w3.org/2000/svg">'+edges+shapes+'</svg></div></div>';
}
window.MAJIN_MINDMAP={render};
})();