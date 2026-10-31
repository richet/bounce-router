#!/usr/bin/env node
// Fake `claude -p --input-format stream-json`: one process, many turns. Each user message line on stdin gets a
// streamed answer naming this process and the turn, then a result; the process stays until stdin ends.
// FAKE_ARGS=<path>  append this process's argv (one JSON line per launch)
// FAKE_FAIL_ON=<n>  exit with code 1 while answering turn n
import fs from 'node:fs';
import {createInterface} from 'node:readline';
const session = `sess-${process.pid}`;
if (process.env.FAKE_ARGS) fs.appendFileSync(process.env.FAKE_ARGS, JSON.stringify(process.argv.slice(2)) + '\n');
const out = value => process.stdout.write(JSON.stringify(value) + '\n');
out({type: 'system', subtype: 'init', session_id: session, tools: []});
let turn = 0;
createInterface({input: process.stdin}).on('line', line => {
  const message = JSON.parse(line);
  const content = message.message.content;
  const text = typeof content === 'string' ? content : content.find(part => part.type === 'text')?.text;
  turn++;
  if (Number(process.env.FAKE_FAIL_ON) === turn) process.exit(1);
  const answer = `pid ${process.pid} turn ${turn}: ${text}`;
  out({type: 'stream_event', session_id: session, event: {type: 'content_block_start', content_block: {type: 'text'}}});
  for (const piece of [answer.slice(0, 5), answer.slice(5)]) out({type: 'stream_event', session_id: session, event: {type: 'content_block_delta', delta: {type: 'text_delta', text: piece}}});
  out({type: 'assistant', session_id: session, message: {content: [{type: 'text', text: answer}]}});
  out({type: 'result', subtype: 'success', is_error: false, session_id: session, result: answer, usage: {input_tokens: 10, output_tokens: 5}});
});
