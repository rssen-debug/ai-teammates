/** Compact read-only browser transcript for smaller cloud-model contexts.
 * Inspired by token-efficient accessibility snapshots, not a copied driver.
 * Keep early + late evidence and headings instead of unbounded page dumps.
 */
export function compactBrowserText(input,{maxChars=2600}={}){
  const cap=Math.max(400,Math.min(6000,Math.floor(Number(maxChars)||2600)));
  const rows=String(input||'').split(/\r?\n/).map(s=>s.replace(/\s+/g,' ').trim()).filter(Boolean);
  const unique=[];const seen=new Set();
  for(const row of rows){
    const key=row.toLocaleLowerCase();
    if(!key||seen.has(key))continue;
    seen.add(key);unique.push(row);
  }
  const budget=Math.max(0,cap-180);
  const selected=[];
  const fullText=unique.join('\n');
  const long=fullText.length>budget || unique.length>30;
  const omitted='… [middle page content omitted]';
  let used=0;
  const add=(row,limit)=>{
    const available=limit-used-1;
    if(available<1)return;
    const piece=row.slice(0,Math.min(available,450));
    if(piece){selected.push(piece);used+=piece.length+1;}
  };
  if(long){
    // Preserve the last three observed rows even when the first twenty are huge.
    // In particular a failure or saved confirmation must not be pushed out.
    const tail=unique.slice(-3);
    const tailBudget=Math.min(450,Math.floor(budget*.4));
    const headBudget=budget-tailBudget-omitted.length-1;
    for(const row of unique.slice(0,-3).slice(0,28)){
      if(used>=headBudget)break;
      add(row,headBudget);
    }
    selected.push(omitted);used+=omitted.length+1;
    for(const row of tail)add(row.slice(0,110),budget);
  } else {
    for(const row of unique)add(row,budget);
  }
  const result=selected.join('\n').slice(0,cap);
  return {text:result,originalChars:String(input||'').length,outputChars:result.length,
    linesRead:rows.length,uniqueLines:unique.length,truncated:result.length<String(input||'').length};
}
