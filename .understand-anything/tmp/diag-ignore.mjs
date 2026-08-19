import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const pluginRoot = 'C:/Users/anwea/.understand-anything/repo/understand-anything-plugin';
const require = createRequire(resolve(pluginRoot, 'package.json'));
const core = await import(pathToFileURL(require.resolve('@understand-anything/core')).href);
const f = core.createIgnoreFilter('D:/codeproject/Hertaloy');
for (const p of ['archive/README.md','archive/foo.md','archive/docs/v4/FOUNDATION_V4.md','.understand-anything/.understandignore']) {
  console.log(p, '->', f.isIgnored(p));
}
