#!/usr/bin/env node
import { main } from "./main.mts";

process.exitCode = await main(process.argv.slice(2));
