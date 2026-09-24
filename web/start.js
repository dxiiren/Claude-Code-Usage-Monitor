// `npm start` = `node build` bound to 127.0.0.1:47291 (set here so it works in cmd, pwsh and bash alike).
process.env.HOST = '127.0.0.1';
process.env.PORT = process.env.PORT || '47291';
await import('./build/index.js');
