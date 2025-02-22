/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */
import { tags } from '@angular-devkit/core';
import { createTypescriptContext, transformTypescript } from './ast_helpers';
import { importFactory } from './import_factory';

describe('@ngtools/webpack transformers', () => {
  describe('import_factory', () => {
    it('should support arrow functions', () => {
      const additionalFiles: Record<string, string> = {
        'lazy/lazy.module.ts': `
          export const LazyModule = {};
        `,
      };
      const input = tags.stripIndent`
        const ɵ0 = () => import('./lazy/lazy.module').then(m => m.LazyModule);
        const routes = [{
          path: 'lazy',
          loadChildren: ɵ0
        }];
      `;
      const output = tags.stripIndent`
        const ɵ0 = () => import("./lazy/lazy.module.ngfactory").then(m => m.LazyModuleNgFactory);
        const routes = [{
          path: 'lazy',
          loadChildren: ɵ0
        }];
      `;

      let warningCalled = false;
      const { program, compilerHost } = createTypescriptContext(input, additionalFiles, true);
      const transformer = importFactory(() => warningCalled = true, () => program.getTypeChecker());
      const result = transformTypescript(undefined, [transformer], program, compilerHost);

      expect(tags.oneLine`${result}`).toEqual(tags.oneLine`${output}`);
      expect(warningCalled).toBeFalsy();
    });

    it('should not transform if the format is different than expected', () => {
      const additionalFiles: Record<string, string> = {
        'lazy/lazy.module.ts': `
          export const LazyModule = {};
        `,
      };
      const input = tags.stripIndent`
        const ɵ0 = () => import('./lazy/lazy.module').then(function (m) { return m.LazyModule; });
        const routes = [{
          path: 'lazy',
          loadChildren: ɵ0
        }];
      `;

      let warningCalled = false;
      const { program, compilerHost } = createTypescriptContext(input, additionalFiles, true);
      const transformer = importFactory(() => warningCalled = true, () => program.getTypeChecker());
      const result = transformTypescript(undefined, [transformer], program, compilerHost);

      expect(tags.oneLine`${result}`).toEqual(tags.oneLine`${input}`);
      expect(warningCalled).toBeTruthy();
    });

    it('should support resolving reexports', () => {
      const additionalFiles: Record<string, string> = {
        'shared/index.ts': `
          export * from './path/to/lazy/lazy.module';
        `,
        'shared/path/to/lazy/lazy.module.ts': `
          export const LazyModule = {};
        `,
      };
      const input = tags.stripIndent`
        const ɵ0 = () => import('./shared').then(m => m.LazyModule);
        const routes = [{
          path: 'lazy',
          loadChildren: ɵ0
        }];
      `;

      const output = tags.stripIndent`
        const ɵ0 = () => import("./shared/path/to/lazy/lazy.module.ngfactory").then(m => m.LazyModuleNgFactory);
        const routes = [{
          path: 'lazy',
          loadChildren: ɵ0
        }];
      `;

      const { program, compilerHost } = createTypescriptContext(input, additionalFiles, true);
      const transformer = importFactory(() => { }, () => program.getTypeChecker());
      const result = transformTypescript(undefined, [transformer], program, compilerHost);

      expect(tags.oneLine`${result}`).toEqual(tags.oneLine`${output}`);
    });
  });
});
