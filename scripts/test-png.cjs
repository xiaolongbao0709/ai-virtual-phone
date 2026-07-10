const fs = require('fs');

// Replicate the parseSillyTavernCharacterFromPng logic
function readPngTextChunk(u8, keyword) {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) {
    if (u8[i] !== sig[i]) return null;
  }

  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let offset = 8;

  while (offset + 12 <= u8.length) {
    const length = dv.getUint32(offset);
    const type = String.fromCharCode(
      u8[offset + 4], u8[offset + 5], u8[offset + 6], u8[offset + 7]
    );

    if (type === 'tEXt') {
      const data = u8.subarray(offset + 8, offset + 8 + length);
      let sep = -1;
      for (let i = 0; i < data.length; i++) {
        if (data[i] === 0) { sep = i; break; }
      }
      if (sep >= 0) {
        const kw = new TextDecoder().decode(data.subarray(0, sep));
        if (kw === keyword) {
          return new TextDecoder('latin1').decode(data.subarray(sep + 1));
        }
      }
    } else if (type === 'iTXt') {
      const data = u8.subarray(offset + 8, offset + 8 + length);
      let pos = 0;
      while (pos < data.length && data[pos] !== 0) pos++;
      const kw = new TextDecoder().decode(data.subarray(0, pos));
      if (kw === keyword) {
        pos++;
        const compressionFlag = data[pos++];
        pos++;
        while (pos < data.length && data[pos] !== 0) pos++;
        pos++;
        while (pos < data.length && data[pos] !== 0) pos++;
        pos++;
        if (compressionFlag === 0) {
          return new TextDecoder().decode(data.subarray(pos));
        }
      }
    }
    offset += 12 + length;
  }
  return null;
}

function pngToDataUrl(u8) {
  return 'data:image/png;base64,' + Buffer.from(u8.buffer).toString('base64');
}

// Test
const buffer = fs.readFileSync('C:\\\\Users\\\\lx\\\\SillyTavern\\\\data\\\\default-user\\\\characters\\\\Reputation.png');
const u8 = new Uint8Array(buffer);

console.log('=== Testing parseCharacterFromPng (native) ===');
const nativeBase64 = readPngTextChunk(u8, 'ai_phone_character');
console.log('Native chunk found:', !!nativeBase64);

console.log('');
console.log('=== Testing parseSillyTavernCharacterFromPng ===');
const charaBase64 = readPngTextChunk(u8, 'chara');
console.log('chara chunk found:', !!charaBase64);

if (charaBase64) {
  try {
    const jsonStr = decodeURIComponent(escape(atob(charaBase64)));
    const obj = JSON.parse(jsonStr);
    
    const data = (typeof obj.data === 'object' && obj.data !== null) ? obj.data : obj;
    
    const name = String(data.name ?? obj.name ?? '');
    const description = String(data.description ?? obj.description ?? '');
    const personality = String(data.personality ?? obj.personality ?? '');
    
    console.log('');
    console.log('Parsed result:');
    console.log('  name:', JSON.stringify(name));
    console.log('  description length:', description.length);
    console.log('  personality length:', personality.length);
    console.log('  tags:', JSON.stringify(data.tags));
    
    const avatarUrl = pngToDataUrl(u8);
    console.log('  avatarUrl length:', avatarUrl.length, 'chars (starts with data:image)');
    
    console.log('');
    console.log('All checks passed! Would return:');
    console.log(JSON.stringify({
      name: name.trim() || 'Imported Character',
      persona: [description, personality].filter(Boolean).join('\\n\\n'),
      avatar: avatarUrl,
      personality: personality || undefined,
      tags: Array.isArray(data.tags) ? data.tags.map(String) : [],
      wechatID: undefined,
      timeZone: undefined,
    }, null, 2).substring(0, 500) + '...');
    
  } catch(e) {
    console.log('ERROR:', e.message);
    console.log(e.stack);
  }
}
