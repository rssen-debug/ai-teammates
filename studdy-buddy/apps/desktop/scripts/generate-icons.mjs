#!/usr/bin/env node
/**
 * Original orange pixel-companion brand icons, generated offline and deterministically.
 * No stock images, network, fonts, package downloads or secrets are required.
 * Produce Windows icon, Electron window icon and breathing/blinking tray frames.
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const build = join(desktop, 'build');
const runtime = join(desktop, 'dist', 'electron');
mkdirSync(build, { recursive: true });
mkdirSync(runtime, { recursive: true });

const COLORS = {
  ink: '#292337', fur: '#A87458', lit: '#CC9270', shaded: '#825446',
  face: '#F4CAA0', muzzle: '#FFE2B5', blush: '#DE9C83',
  white: '#FFF6EC', pupil: '#29293D', shine: '#FFFFFF',
  sparkle: '#8EDFC5',
};

const parse = (hex) => [parseInt(hex.slice(1,3),16),parseInt(hex.slice(3,5),16),parseInt(hex.slice(5,7),16),255];

function portrait(size, expression = 'awake') {
  const n = 48;
  const pixels = new Uint8Array(n*n*4);
  function plot(x,y,color) {
    x = Math.round(x); y = Math.round(y);
    if(x<0||y<0||x>=n||y>=n)return;
    const index=(y*n+x)*4;
    pixels.set(parse(color),index);
  }
  function rect(x,y,w,h,color) {
    for(let yy=Math.floor(y);yy<y+h;yy++)for(let xx=Math.floor(x);xx<x+w;xx++)plot(xx,yy,color);
  }
  function ellipse(x,y,w,h,color) {
    for(let yy=Math.floor(y);yy<y+h;yy++)for(let xx=Math.floor(x);xx<x+w;xx++){
      const nx=(xx+0.5-x)/w*2-1,ny=(yy+0.5-y)/h*2-1;
      if(nx*nx+ny*ny<=1)plot(xx,yy,color);
    }
  }
  // Original orange pixel companion. No monkey ears, fur or stock emoji.
  // The same pixel design is used on the desktop, in the taskbar and tray.
  rect(12,9,24,4,COLORS.ink);
  rect(8,13,32,5,COLORS.ink);
  rect(5,18,38,23,COLORS.ink);
  rect(9,41,7,5,COLORS.ink);rect(32,41,7,5,COLORS.ink);
  rect(12,44,5,4,COLORS.ink);rect(23,44,5,4,COLORS.ink);rect(32,44,5,4,COLORS.ink);
  rect(13,12,22,4,'#ED9466');
  rect(9,16,30,6,'#ED9466');
  rect(6,21,36,19,'#E7784D');
  rect(10,40,28,4,'#E7784D');
  rect(14,44,3,3,'#E7784D');rect(24,44,3,3,'#E7784D');rect(33,44,3,3,'#E7784D');
  rect(32,20,8,3,'#CE6042');
  if (expression === 'blink' || expression === 'live-blink') {
    rect(13,27,7,2,COLORS.ink);rect(29,27,7,2,COLORS.ink);
  } else {
    const look = expression === 'curious' ? 2 : 0;
    rect(14+look,25,6,7,COLORS.ink);rect(29+look,25,6,7,COLORS.ink);
    rect(15+look,26,2,2,'#FFF4E8');rect(30+look,26,2,2,'#FFF4E8');
  }
  rect(22,35,5,2,COLORS.ink);
  if (expression === 'live' || expression === 'live-blink' || expression === 'active') {
    rect(36,36,11,11,COLORS.ink);
    rect(38,38,7,7,expression === 'live-blink' ? '#B2FFC3' : '#34EF7A');
    rect(39,39,2,2,'#E6FFEE');
  }
  const rgba=Buffer.alloc(size*size*4);
  for(let y=0;y<size;y++)for(let x=0;x<size;x++){
    const sx=Math.floor(x*n/size),sy=Math.floor(y*n/size);
    const from=(sy*n+sx)*4,to=(y*size+x)*4;
    rgba[to]=pixels[from];rgba[to+1]=pixels[from+1];
    rgba[to+2]=pixels[from+2];rgba[to+3]=pixels[from+3];
  }
  return encodePng(size,size,rgba);
}
const crcTable = Array.from({length:256},(_,n)=>{
  let c=n;
  for(let i=0;i<8;i++)c=c&1?0xEDB88320^(c>>>1):c>>>1;
  return c>>>0;
});
function chunk(name,data) {
  const tag=Buffer.from(name);
  const length=Buffer.alloc(4);length.writeUInt32BE(data.length);
  let crc=0xFFFFFFFF;
  for(const b of Buffer.concat([tag,data]))crc=crcTable[(crc^b)&255]^(crc>>>8);
  const trailer=Buffer.alloc(4);trailer.writeUInt32BE((crc^0xFFFFFFFF)>>>0);
  return Buffer.concat([length,tag,data,trailer]);
}
function encodePng(width,height,rgba) {
  const header=Buffer.alloc(13);
  header.writeUInt32BE(width,0);header.writeUInt32BE(height,4);
  header[8]=8;header[9]=6;
  const raw=Buffer.alloc(height*(width*4+1));
  for(let y=0;y<height;y++)rgba.copy(raw,y*(width*4+1)+1,y*width*4,(y+1)*width*4);
  return Buffer.concat([
    Buffer.from([137,80,78,71,13,10,26,10]),
    chunk('IHDR',header),chunk('IDAT',deflateSync(raw,{level:9})),chunk('IEND',Buffer.alloc(0)),
  ]);
}
function buildIco() {
  const sizes=[16,24,32,48,64,128,256];
  const images=sizes.map(size=>portrait(size));
  const header=Buffer.alloc(6+16*images.length);
  header.writeUInt16LE(1,2);header.writeUInt16LE(images.length,4);
  let offset=header.length;
  images.forEach((buffer,index)=>{
    const at=6+index*16;
    const size=sizes[index];
    header[at]=size===256?0:size;header[at+1]=size===256?0:size;
    header[at+2]=0;header[at+3]=0;header.writeUInt16LE(1,at+4);
    header.writeUInt16LE(32,at+6);header.writeUInt32LE(buffer.length,at+8);
    header.writeUInt32LE(offset,at+12);offset+=buffer.length;
  });
  return Buffer.concat([header,...images]);
}
writeFileSync(join(build,'buddy.ico'),buildIco());
writeFileSync(join(build,'buddy.png'),portrait(256));
writeFileSync(join(runtime,'buddy-icon.png'),portrait(256));
writeFileSync(join(runtime,'buddy-tray.png'),portrait(32));
writeFileSync(join(runtime,'buddy-blink.png'),portrait(32,'blink'));
writeFileSync(join(runtime,'buddy-curious.png'),portrait(32,'curious'));
writeFileSync(join(runtime,'buddy-active.png'),portrait(32,'active'));
writeFileSync(join(runtime,'buddy-live.png'),portrait(32,'live'));
writeFileSync(join(runtime,'buddy-live-blink.png'),portrait(32,'live-blink'));

console.log('Original pixel monkey desktop, taskbar, tray and animation frames generated.');
