/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */
import {
  BuildOptimizerWebpackPlugin,
  buildOptimizerLoaderPath,
} from '@angular-devkit/build-optimizer';
import { tags } from '@angular-devkit/core';
import * as CopyWebpackPlugin from 'copy-webpack-plugin';
import * as path from 'path';
import { ScriptTarget } from 'typescript';
import {
  Compiler,
  Configuration,
  ContextReplacementPlugin,
  HashedModuleIdsPlugin,
  Output,
  debug,
} from 'webpack';
import { RawSource } from 'webpack-sources';
import { AssetPatternClass, ExtraEntryPoint } from '../../../browser/schema';
import { BuildBrowserFeatures } from '../../../utils/build-browser-features';
import { BundleBudgetPlugin } from '../../plugins/bundle-budget';
import { CleanCssWebpackPlugin } from '../../plugins/cleancss-webpack-plugin';
import { NamedLazyChunksPlugin } from '../../plugins/named-chunks-plugin';
import { ScriptsWebpackPlugin } from '../../plugins/scripts-webpack-plugin';
import { findAllNodeModules, findUp } from '../../utilities/find-up';
import { WebpackConfigOptions } from '../build-options';
import { getEsVersionForFileName, getOutputHashFormat, normalizeExtraEntryPoints } from './utils';

const ProgressPlugin = require('webpack/lib/ProgressPlugin');
const CircularDependencyPlugin = require('circular-dependency-plugin');
const TerserPlugin = require('terser-webpack-plugin');

// tslint:disable-next-line:no-any
const g: any = typeof global !== 'undefined' ? global : {};

// tslint:disable-next-line:no-big-function
export function getCommonConfig(wco: WebpackConfigOptions): Configuration {
  const { root, projectRoot, buildOptions, tsConfig } = wco;
  const { styles: stylesOptimization, scripts: scriptsOptimization } = buildOptions.optimization;
  const {
    styles: stylesSourceMap,
    scripts: scriptsSourceMap,
    vendor: vendorSourceMap,
  } = buildOptions.sourceMap;

  const nodeModules = findUp('node_modules', projectRoot);
  if (!nodeModules) {
    throw new Error('Cannot locate node_modules directory.');
  }

  // tslint:disable-next-line:no-any
  const extraPlugins: any[] = [];
  const entryPoints: { [key: string]: string[] } = {};

  const targetInFileName = getEsVersionForFileName(
    buildOptions.scriptTargetOverride,
    buildOptions.esVersionInFileName,
  );

  if (buildOptions.main) {
    entryPoints['main'] = [path.resolve(root, buildOptions.main)];
  }

  if (wco.buildOptions.platform !== 'server') {
    const buildBrowserFeatures = new BuildBrowserFeatures(
      projectRoot,
      tsConfig.options.target || ScriptTarget.ES5,
    );
    if ((buildOptions.scriptTargetOverride || tsConfig.options.target) === ScriptTarget.ES5) {
      if (
        buildOptions.es5BrowserSupport ||
        (buildOptions.es5BrowserSupport === undefined && buildBrowserFeatures.isEs5SupportNeeded())
      ) {
        // The nomodule polyfill needs to be inject prior to any script and be
        // outside of webpack compilation because otherwise webpack will cause the
        // script to be wrapped in window["webpackJsonp"] which causes this to fail.
        if (buildBrowserFeatures.isNoModulePolyfillNeeded()) {
          const noModuleScript: ExtraEntryPoint = {
            bundleName: 'polyfills-nomodule-es5',
            input: path.join(__dirname, '..', 'safari-nomodule.js'),
          };
          buildOptions.scripts = buildOptions.scripts
            ? [...buildOptions.scripts, noModuleScript]
            : [noModuleScript];
        }

        // For differential loading we don't need to generate a seperate polyfill file
        // because they will be loaded exclusivly based on module and nomodule
        const polyfillsChunkName = buildBrowserFeatures.isDifferentialLoadingNeeded()
          ? 'polyfills'
          : 'polyfills-es5';

        entryPoints[polyfillsChunkName] = [path.join(__dirname, '..', 'es5-polyfills.js')];
        if (!buildOptions.aot) {
          entryPoints[polyfillsChunkName].push(path.join(__dirname, '..', 'es5-jit-polyfills.js'));
        }
      }
    }

    if (buildOptions.polyfills) {
      entryPoints['polyfills'] = [
        ...(entryPoints['polyfills'] || []),
        path.resolve(root, buildOptions.polyfills),
      ];
    }

    if (!buildOptions.aot) {
      entryPoints['polyfills'] = [
        ...(entryPoints['polyfills'] || []),
        path.join(__dirname, '..', 'jit-polyfills.js'),
      ];
    }
  }

  if (buildOptions.profile || process.env['NG_BUILD_PROFILING']) {
    extraPlugins.push(
      new debug.ProfilingPlugin({
        outputPath: path.resolve(root, `chrome-profiler-events${targetInFileName}.json`),
      }),
    );
  }

  // determine hashing format
  const hashFormat = getOutputHashFormat(buildOptions.outputHashing || 'none');

  // process global scripts
  if (buildOptions.scripts.length > 0) {
    const globalScriptsByBundleName = normalizeExtraEntryPoints(
      buildOptions.scripts,
      'scripts',
    ).reduce((prev: { bundleName: string; paths: string[]; inject: boolean }[], curr) => {
      const bundleName = curr.bundleName;
      const resolvedPath = path.resolve(root, curr.input);
      const existingEntry = prev.find(el => el.bundleName === bundleName);
      if (existingEntry) {
        if (existingEntry.inject && !curr.inject) {
          // All entries have to be lazy for the bundle to be lazy.
          throw new Error(
            `The ${curr.bundleName} bundle is mixing injected and non-injected scripts.`,
          );
        }

        existingEntry.paths.push(resolvedPath);
      } else {
        prev.push({
          bundleName,
          paths: [resolvedPath],
          inject: curr.inject,
        });
      }

      return prev;
    }, []);

    // Add a new asset for each entry.
    globalScriptsByBundleName.forEach(script => {
      // Lazy scripts don't get a hash, otherwise they can't be loaded by name.
      const hash = script.inject ? hashFormat.script : '';
      const bundleName = script.bundleName;

      extraPlugins.push(
        new ScriptsWebpackPlugin({
          name: bundleName,
          sourceMap: scriptsSourceMap,
          filename: `${path.basename(bundleName)}${hash}.js`,
          scripts: script.paths,
          basePath: projectRoot,
        }),
      );
    });
  }

  // process asset entries
  if (buildOptions.assets) {
    const copyWebpackPluginPatterns = buildOptions.assets.map((asset: AssetPatternClass) => {
      // Resolve input paths relative to workspace root and add slash at the end.
      asset.input = path.resolve(root, asset.input).replace(/\\/g, '/');
      asset.input = asset.input.endsWith('/') ? asset.input : asset.input + '/';
      asset.output = asset.output.endsWith('/') ? asset.output : asset.output + '/';

      if (asset.output.startsWith('..')) {
        const message = 'An asset cannot be written to a location outside of the output path.';
        throw new Error(message);
      }

      return {
        context: asset.input,
        // Now we remove starting slash to make Webpack place it from the output root.
        to: asset.output.replace(/^\//, ''),
        ignore: asset.ignore,
        from: {
          glob: asset.glob,
          dot: true,
        },
      };
    });

    const copyWebpackPluginOptions = { ignore: ['.gitkeep', '**/.DS_Store', '**/Thumbs.db'] };

    const copyWebpackPluginInstance = new CopyWebpackPlugin(
      copyWebpackPluginPatterns,
      copyWebpackPluginOptions,
    );
    extraPlugins.push(copyWebpackPluginInstance);
  }

  if (buildOptions.progress) {
    extraPlugins.push(new ProgressPlugin({ profile: buildOptions.verbose }));
  }

  if (buildOptions.showCircularDependencies) {
    extraPlugins.push(
      new CircularDependencyPlugin({
        exclude: /([\\\/]node_modules[\\\/])|(ngfactory\.js$)/,
      }),
    );
  }

  if (buildOptions.statsJson) {
    extraPlugins.push(
      new (class {
        apply(compiler: Compiler) {
          compiler.hooks.emit.tap('angular-cli-stats', compilation => {
            const data = JSON.stringify(compilation.getStats().toJson('verbose'));
            compilation.assets[`stats${targetInFileName}.json`] = new RawSource(data);
          });
        }
      })(),
    );
  }

  if (buildOptions.namedChunks) {
    extraPlugins.push(new NamedLazyChunksPlugin());
  }

  let sourceMapUseRule;
  if ((scriptsSourceMap || stylesSourceMap) && vendorSourceMap) {
    sourceMapUseRule = {
      use: [
        {
          loader: 'source-map-loader',
        },
      ],
    };
  }

  let buildOptimizerUseRule;
  if (buildOptions.buildOptimizer) {
    extraPlugins.push(new BuildOptimizerWebpackPlugin());
    buildOptimizerUseRule = {
      use: [
        {
          loader: buildOptimizerLoaderPath,
          options: { sourceMap: scriptsSourceMap },
        },
      ],
    };
  }

  // Allow loaders to be in a node_modules nested inside the devkit/build-angular package.
  // This is important in case loaders do not get hoisted.
  // If this file moves to another location, alter potentialNodeModules as well.
  const loaderNodeModules = findAllNodeModules(__dirname, projectRoot);
  loaderNodeModules.unshift('node_modules');

  // Load rxjs path aliases.
  // https://github.com/ReactiveX/rxjs/blob/master/doc/pipeable-operators.md#build-and-treeshaking
  let alias = {};
  try {
    const rxjsPathMappingImport = wco.supportES2015
      ? 'rxjs/_esm2015/path-mapping'
      : 'rxjs/_esm5/path-mapping';
    const rxPaths = require(require.resolve(rxjsPathMappingImport, { paths: [projectRoot] }));
    alias = rxPaths(nodeModules);
  } catch {}

  const extraMinimizers = [];
  if (stylesOptimization) {
    extraMinimizers.push(
      new CleanCssWebpackPlugin({
        sourceMap: stylesSourceMap,
        // component styles retain their original file name
        test: file => /\.(?:css|scss|sass|less|styl)$/.test(file),
      }),
    );
  }

  if (scriptsOptimization) {
    let angularGlobalDefinitions = {
      ngDevMode: false,
      ngI18nClosureMode: false,
    };

    try {
      // Try to load known global definitions from @angular/compiler-cli.
      // tslint:disable-next-line:no-implicit-dependencies
      const GLOBAL_DEFS_FOR_TERSER = require('@angular/compiler-cli').GLOBAL_DEFS_FOR_TERSER;
      if (GLOBAL_DEFS_FOR_TERSER) {
        angularGlobalDefinitions = GLOBAL_DEFS_FOR_TERSER;
      }
    } catch {
      // Do nothing, the default above will be used instead.
    }

    const terserOptions = {
      ecma: wco.supportES2015 ? 6 : 5,
      warnings: !!buildOptions.verbose,
      safari10: true,
      output: {
        ascii_only: true,
        comments: false,
        webkit: true,
      },
      // On server, we don't want to compress anything. We still set the ngDevMode = false for it
      // to remove dev code, and ngI18nClosureMode to remove Closure compiler i18n code
      compress:
        buildOptions.platform == 'server'
          ? {
              global_defs: angularGlobalDefinitions,
            }
          : {
              pure_getters: buildOptions.buildOptimizer,
              // PURE comments work best with 3 passes.
              // See https://github.com/webpack/webpack/issues/2899#issuecomment-317425926.
              passes: buildOptions.buildOptimizer ? 3 : 1,
              global_defs: angularGlobalDefinitions,
            },
      // We also want to avoid mangling on server.
      ...(buildOptions.platform == 'server' ? { mangle: false } : {}),
    };

    extraMinimizers.push(
      new TerserPlugin({
        sourceMap: scriptsSourceMap,
        parallel: true,
        cache: true,
        terserOptions,
      }),
    );
  }

  if (
    wco.tsConfig.options.target !== undefined &&
    wco.tsConfig.options.target >= ScriptTarget.ES2017
  ) {
    wco.logger.warn(tags.stripIndent`
      WARNING: Zone.js does not support native async/await in ES2017.
      These blocks are not intercepted by zone.js and will not triggering change detection.
      See: https://github.com/angular/zone.js/pull/1140 for more information.
    `);
  }

  return {
    mode: scriptsOptimization || stylesOptimization ? 'production' : 'development',
    devtool: false,
    profile: buildOptions.statsJson,
    resolve: {
      extensions: ['.ts', '.tsx', '.mjs', '.js'],
      symlinks: !buildOptions.preserveSymlinks,
      modules: [wco.tsConfig.options.baseUrl || projectRoot, 'node_modules'],
      alias,
    },
    resolveLoader: {
      modules: loaderNodeModules,
    },
    context: projectRoot,
    entry: entryPoints,
    output: {
      futureEmitAssets: true,
      path: path.resolve(root, buildOptions.outputPath as string),
      publicPath: buildOptions.deployUrl,
      filename: `[name]${targetInFileName}${hashFormat.chunk}.js`,
      // cast required until typings include `futureEmitAssets` property
    } as Output,
    watch: buildOptions.watch,
    watchOptions: {
      poll: buildOptions.poll,
    },
    performance: {
      hints: false,
    },
    module: {
      // Show an error for missing exports instead of a warning.
      strictExportPresence: true,
      rules: [
        {
          test: /\.(eot|svg|cur|jpg|png|webp|gif|otf|ttf|woff|woff2|ani)$/,
          loader: 'file-loader',
          options: {
            name: `[name]${hashFormat.file}.[ext]`,
          },
        },
        {
          // Mark files inside `@angular/core` as using SystemJS style dynamic imports.
          // Removing this will cause deprecation warnings to appear.
          test: /[\/\\]@angular[\/\\]core[\/\\].+\.js$/,
          parser: { system: true },
        },
        {
          test: /[\/\\]hot[\/\\]emitter.js$/,
          parser: { node: { events: true } },
        },
        {
          test: /[\/\\]webpack-dev-server[\/\\]client[\/\\]utils[\/\\]createSocketUrl.js$/,
          parser: { node: { querystring: true } },
        },
        {
          test: /\.js$/,
          ...buildOptimizerUseRule,
        },
        {
          test: /\.js$/,
          exclude: /(ngfactory|ngstyle).js$/,
          enforce: 'pre',
          ...sourceMapUseRule,
        },
      ],
    },
    optimization: {
      noEmitOnErrors: true,
      minimizer: [
        new HashedModuleIdsPlugin(),
        // TODO: check with Mike what this feature needs.
        new BundleBudgetPlugin({ budgets: buildOptions.budgets }),
        ...extraMinimizers,
      ],
    },
    plugins: [
      // Always replace the context for the System.import in angular/core to prevent warnings.
      // https://github.com/angular/angular/issues/11580
      // With VE the correct context is added in @ngtools/webpack, but Ivy doesn't need it at all.
      new ContextReplacementPlugin(/\@angular(\\|\/)core(\\|\/)/),
      ...extraPlugins,
    ],
  };
}
