import fs from 'node:fs';
// PNG 已压缩；以 ZIP Store 保存原字节，兼容常见解压工具。
const table = Array.from({length:256},(_,n)=>{for(let i=0;i<8;i++) n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
export function crc32(b){let c=0xffffffff;for(const n of b)c=table[(c^n)&255]^(c>>>8);return (c^0xffffffff)>>>0;}
export function writeZip(target, entries){
  const fd=fs.openSync(target,'w'), central=[];let offset=0;
  for(const {file,name} of entries){const b=fs.readFileSync(file),n=Buffer.from(name),crc=crc32(b);const h=Buffer.alloc(30);h.writeUInt32LE(0x04034b50);h.writeUInt16LE(20,4);h.writeUInt16LE(0x800,6);h.writeUInt16LE(0x5d63,12);h.writeUInt32LE(crc,14);h.writeUInt32LE(b.length,18);h.writeUInt32LE(b.length,22);h.writeUInt16LE(n.length,26);fs.writeSync(fd,h);fs.writeSync(fd,n);fs.writeSync(fd,b);
    const c=Buffer.alloc(46);c.writeUInt32LE(0x02014b50);c.writeUInt16LE(20,4);c.writeUInt16LE(20,6);c.writeUInt16LE(0x800,8);c.writeUInt16LE(0x5d63,14);c.writeUInt32LE(crc,16);c.writeUInt32LE(b.length,20);c.writeUInt32LE(b.length,24);c.writeUInt16LE(n.length,28);c.writeUInt32LE(offset,42);central.push(c,n);offset+=h.length+n.length+b.length;
  }
  const size=central.reduce((n,b)=>n+b.length,0);for(const b of central)fs.writeSync(fd,b);const end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(size,12);end.writeUInt32LE(offset,16);fs.writeSync(fd,end);fs.closeSync(fd);
}
