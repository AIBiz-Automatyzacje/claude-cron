// Team OS — odczyt treści wiadomości z `--content` albo `--content-file`.
//
// `--content-file` jest bezpieczną drogą dla treści wielolinijkowej i takiej z cudzysłowami:
// plik nie przechodzi przez parser linii poleceń systemu, więc nic go nie rozbije
// (patrz komentarz w args.mjs — utrata połowy raportu na Windowsie 17.08.2026).

import fs from 'node:fs';

import { ArgError } from './args.mjs';

export function readContent(args, { readFile = (p) => fs.readFileSync(p, 'utf8') } = {}) {
  const file = args['content-file'];
  if (file === undefined) return args.content ?? null;

  if (args.content !== undefined) {
    throw new ArgError('Podaj albo --content, albo --content-file — nie oba naraz.');
  }
  try {
    // BOM z Windowsowego `Out-File`/`Set-Content` wjechałby do treści jako niewidzialny
    // znak na starcie wiadomości — ta sama pułapka co z settings.json u Filipa.
    return readFile(file).replace(/^﻿/, '');
  } catch (e) {
    throw new ArgError(`Nie mogę odczytać --content-file ${file}: ${e.message}`);
  }
}
