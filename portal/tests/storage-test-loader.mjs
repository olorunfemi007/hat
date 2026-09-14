import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';

// Run the same TypeScript modules as Next, stubbing only Next's import guard.
export function loadTypeScript(filename, mocks = {}) {
  const cache = new Map();
  function load(file) {
    file = path.resolve(file);
    if (cache.has(file)) return cache.get(file);
    const loadedModule = { exports: {} };
    cache.set(file, loadedModule.exports);
    const nativeRequire = createRequire(file);
    const require = (name) => {
      if (name === 'server-only') return {};
      if (Object.hasOwn(mocks, name)) return mocks[name];
      if (name.startsWith('.')) {
        const resolved = path.resolve(path.dirname(file), name);
        for (const candidate of [resolved + '.ts', path.join(resolved, 'index.ts')]) {
          if (fs.existsSync(candidate)) return load(candidate);
        }
      }
      return nativeRequire(name);
    };
    const compiled = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    }).outputText;
    vm.runInNewContext(compiled, {
      module: loadedModule, exports: loadedModule.exports, require, URL, Buffer, process, AbortSignal,
      Request, Response, ReadableStream, setTimeout, clearTimeout, console,
    }, { filename: file });
    cache.set(file, loadedModule.exports);
    return loadedModule.exports;
  }
  return load(filename);
}
