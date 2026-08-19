const fs = require('fs');
const root = 'D:/codeproject/Hertaloy';
const old = JSON.parse(fs.readFileSync(root + '/.understand-anything/intermediate/scan-result.json', 'utf8'));
const scan = JSON.parse(fs.readFileSync(root + '/.understand-anything/tmp/ua-scan-files2.json', 'utf8'));
const im = JSON.parse(fs.readFileSync(root + '/.understand-anything/tmp/ua-import-map-output3.json', 'utf8'));
const desc = 'Hertaloy / Nodeflow V5 是一个正在重建为 V5 嵌套容器运行时的本地 CLI 工作流项目，采用 pnpm workspace 与 TypeScript 组织内核编排、沙箱执行面、持久化与权限层；当前 hertaloy agent、MCP 与画布能力尚处于起步阶段。';
const out = {
  name: old.name,
  description: desc,
  languages: old.languages,
  frameworks: old.frameworks,
  files: scan.files,
  totalFiles: scan.totalFiles,
  filteredByIgnore: scan.filteredByIgnore,
  estimatedComplexity: scan.estimatedComplexity,
  importMap: im.importMap
};
fs.writeFileSync(root + '/.understand-anything/intermediate/scan-result.json', JSON.stringify(out, null, 2));
console.log('merged: files=' + out.files.length + ' importMapKeys=' + Object.keys(out.importMap).length);
