const ignore = (await import('file:///C:/Users/anwea/.understand-anything/repo/understand-anything-plugin/node_modules/ignore/index.js')).default;
const ig = ignore();
ig.add(['archive/','!archive/README.md']);
for (const p of ['archive/README.md','archive/foo.md']) console.log(p, ig.ignores(p));
