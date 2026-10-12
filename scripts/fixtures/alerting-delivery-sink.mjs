// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Olivier Albertini
//
// This file is part of MapleSpire.
// MapleSpire is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published
// by the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// MapleSpire is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU Affero General Public License for more details.

import http from 'node:http'
import net from 'node:net'
import { randomUUID } from 'node:crypto'

const bootId = randomUUID()
const events = []
const sockets = new Set()
let sequence = 0
function record(kind, data = {}) {
  const event = { sequence: ++sequence, bootId, kind, at: new Date().toISOString(), ...data }
  events.push(event)
  return event
}

// A native SMTP refusal, before authentication or STARTTLS. This does not
// qualify successful SMTP delivery, which has its separate real SES drill.
const smtp = net.createServer(socket => {
  sockets.add(socket)
  socket.on('error', error => record('smtp-socket-error', { code: error.code }))
  socket.on('close', () => sockets.delete(socket))
  record('smtp-refusal')
  socket.end('421 deliberate isolated alert-delivery refusal\r\n')
})
smtp.listen(1025, '0.0.0.0')

const httpServer = http.createServer(async (request, response) => {
  if (request.method === 'GET' && request.url === '/events') {
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ bootId, events }))
    return
  }
  let body = ''
  for await (const chunk of request) {
    body += chunk
    if (Buffer.byteLength(body) > 1048576) { response.writeHead(413); response.end(); return }
  }
  const input = new URLSearchParams(body)
  const subject = input.get('Subject') ?? ''
  const topic = input.get('TopicArn')
  const message = input.get('Message')
  // AWS Publish requires a UTF-8 subject shorter than 100 characters, without
  // line breaks or controls. A permissive sink would miss a real over-length
  // subject rejection; keep this boundary independent from the config template.
  const invalid = request.method !== 'POST' || request.url !== '/'
    || input.get('Action') !== 'Publish' || !message || !topic
    || [...subject].length >= 100 || /[\u0000-\u001f\u007f-\u009f]/u.test(subject)
    || !String(request.headers.authorization).includes('Credential=AKIAABCDEFGHIJKLMNOP/')
  record(invalid ? 'sns-rejected' : 'sns-publish', { topic, subject, message })
  response.setHeader('content-type', 'text/xml')
  if (invalid) {
    response.writeHead(400)
    response.end('<ErrorResponse><Error><Type>Sender</Type><Code>InvalidParameter</Code><Message>Invalid SNS fixture request or Subject</Message></Error><RequestId>fixture</RequestId></ErrorResponse>')
  } else {
    response.end('<PublishResponse xmlns="http://sns.amazonaws.com/doc/2010-03-31/"><PublishResult><MessageId>' + randomUUID() + '</MessageId></PublishResult></PublishResponse>')
  }
})
httpServer.listen(8080, '0.0.0.0')
const stop = () => {
  for (const socket of sockets) socket.destroy()
  smtp.close()
  httpServer.close()
  httpServer.closeAllConnections()
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
