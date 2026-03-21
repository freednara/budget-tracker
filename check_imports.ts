import fs from 'fs';
import path from 'path';

const rootDir = process.cwd();
const filesToCheck = [
  'app.ts',
  ...(fs.readdirSync(path.join(rootDir, 'js/modules'), { recursive: true }) as string[])
    .filter(f => f.endsWith('.ts'))
    .map(f => path.join('js/modules', f)),
  ...(fs.readdirSync(path.join(rootDir, 'js/workers'), { recursive: true }) as string[])
    .filter(f => f.endsWith('.ts'))
    .map(f => path.join('js/workers', f))
];

const issues = [];

for (const fileRelativePath of filesToCheck) {
  const filePath = path.join(rootDir, fileRelativePath);
  if (!fs.statSync(filePath).isFile()) continue;

  const content = fs.readFileSync(filePath, 'utf-8');
  const importRegex = /(?:import|from)\s+['"](\.\/|\.\.\/)([^'"]*)['"]/g;
  let match;

  while ((match = importRegex.exec(content)) !== null) {
    const importPath = match[2];
    const fullImportPath = match[1] + importPath;

    // Check extension
    if (!fullImportPath.endsWith('.js')) {
      issues.push({
        file: fileRelativePath,
        import: fullImportPath,
        reason: 'Missing .js extension'
      });
    }

    // Check existence
    const absoluteImportPath = path.resolve(path.dirname(filePath), fullImportPath);
    let targetFileTs = absoluteImportPath.replace(/\.js$/, '.ts');
    let targetFileDts = absoluteImportPath.replace(/\.js$/, '.d.ts');
    let targetFileJs = absoluteImportPath;

    // Handle index.js -> index.ts
    if (fs.existsSync(absoluteImportPath) && fs.statSync(absoluteImportPath).isDirectory()) {
       // It's a directory, might be looking for index.js
       targetFileTs = path.join(absoluteImportPath, 'index.ts');
       targetFileDts = path.join(absoluteImportPath, 'index.d.ts');
       targetFileJs = path.join(absoluteImportPath, 'index.js');
    }

    const exists = fs.existsSync(targetFileTs) || fs.existsSync(targetFileDts) || fs.existsSync(targetFileJs) || fs.existsSync(absoluteImportPath);

    if (!exists) {
      issues.push({
        file: fileRelativePath,
        import: fullImportPath,
        reason: `File does not exist (checked ${targetFileTs} and ${targetFileDts})`
      });
    }
  }
}

if (issues.length > 0) {
  console.log(JSON.stringify(issues, null, 2));
} else {
  console.log('No issues found');
}
