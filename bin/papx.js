#!/usr/bin/env node
// papx — CLI for Paper design tools.
//
// Subcommands:
//   pdf <prefix>   Build a PDF from Paper artboards named <prefix>/N.
//
// Each subcommand has its own --help:
//   papx pdf --help

import { runPdf, PDF_HELP } from '../src/pdf.js';

const ROOT_HELP = `Usage: papx <command> [options]

Commands:
  pdf <prefix>     Build an optimised PDF from Paper artboards

Run 'papx <command> --help' for command-specific options.
See the README for details: https://github.com/Cwejman/papx`;

async function main() {
  const [, , subcommand, ...rest] = process.argv;

  if (!subcommand || subcommand === '-h' || subcommand === '--help' || subcommand === 'help') {
    console.log(ROOT_HELP);
    process.exit(0);
  }

  if (subcommand === '--version' || subcommand === '-v') {
    const { readFileSync } = await import('node:fs');
    const { resolve, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const pkgPath = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    console.log(pkg.version);
    process.exit(0);
  }

  switch (subcommand) {
    case 'pdf':
      await runPdf(rest);
      break;
    default:
      console.error(`Unknown command: ${subcommand}\n`);
      console.error(ROOT_HELP);
      process.exit(1);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
