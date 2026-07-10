const fs = require('fs');
const path = require('path');

const dirs = [
  'D:\\xsjproject\\xiaoyuanji',
  'D:\\xsjproject\\xiyuji\\xiyu.online-main\\xiyu.online-main'
];

const keywords = ['chara', 'readPng', 'pngToDataUrl', 'parsePng', 'tavern_card', 'importCharacter', 'readPNG'];

function searchFiles(dir) {
  try {
    const files = fs.readdirSync(dir, { withFileTypes: true });
    for (const file of files) {
      const fullPath = path.join(dir, file.name);
      if (file.isDirectory() && !file.name.startsWith('.')) {
        searchFiles(fullPath);
      } else if (file.name.endsWith('.js') || file.name.endsWith('.html')) {
        try {
          const content = fs.readFileSync(fullPath, 'utf-8');
          for (const kw of keywords) {
            if (content.includes(kw)) {
              const lines = content.split('\\n');
              for (let i = 0; i < lines.length; i++) {
                if (lines[i].includes(kw)) {
                  console.log(fullPath + ':' + (i+1) + ': ' + lines[i].trim().substring(0, 120));
                }
              }
            }
          }
        } catch(e) {}
      }
    }
  } catch(e) {}
}

for (const dir of dirs) {
  console.log('Searching:', dir);
  searchFiles(dir);
}
