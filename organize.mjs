#!/usr/bin/env node

import { runCli } from "./src/file-organizer.mjs";

process.exitCode = await runCli(process.argv.slice(2));
