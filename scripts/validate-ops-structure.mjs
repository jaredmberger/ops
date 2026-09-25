import fs from 'node:fs';
import path from 'node:path';

const root=process.cwd();
const wranglerPath=path.join(root,'wrangler.toml');
const readmePath=path.join(root,'README.md');

const wrangler=fs.readFileSync(wranglerPath,'utf8');
const readme=fs.readFileSync(readmePath,'utf8');

const mainMatch=wrangler.match(/^main\s*=\s*"([^"]+)"/m);
if(!mainMatch)throw new Error('wrangler.toml does not declare a main entrypoint.');

const mainPath=mainMatch[1];
const absoluteMain=path.join(root,mainPath);
if(!fs.existsSync(absoluteMain))throw new Error(`wrangler.toml main does not exist: ${mainPath}`);

if(!readme.includes(`Current entrypoint: \`${mainPath}\``)){
  throw new Error(`README production entrypoint does not match wrangler.toml: ${mainPath}`);
}

const visited=new Set();
function verifyImports(filePath){
  const absolute=path.resolve(filePath);
  if(visited.has(absolute))return;
  visited.add(absolute);

  const source=fs.readFileSync(absolute,'utf8');
  const importRe=/from\s+['"]([^'"]+)['"]/g;
  for(const match of source.matchAll(importRe)){
    const spec=match[1];
    if(!spec.startsWith('.'))continue;
    const target=path.resolve(path.dirname(absolute),spec);
    if(!fs.existsSync(target)){
      throw new Error(`Missing relative import from ${path.relative(root,absolute)}: ${spec}`);
    }
    verifyImports(target);
  }
}

verifyImports(absoluteMain);

const chain=[...visited].map(file=>path.relative(root,file)).sort();
console.log(`Validated production entrypoint: ${mainPath}`);
console.log(`Validated ${chain.length} files in the active import chain.`);
for(const file of chain)console.log(` - ${file}`);
