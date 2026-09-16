import { expect, test } from '@playwright/test'
import type { Browser, BrowserContext, Page, WebSocketRoute } from '@playwright/test'

async function create(page: Page, title = 'Team catch-up', name = 'Alice') {
  await page.goto('/')
  await page.getByLabel('Your name', { exact: true }).fill(name)
  await page.getByLabel(/Meeting title/).fill(title)
  await page.getByRole('button', { name: 'Create room', exact: true }).click()
  await expect(page.getByRole('status').getByText('Connected', { exact: true })).toBeVisible()
  return (await page.getByTestId('room-code').textContent())!
}

async function join(page: Page, code: string, name = 'Bob', byLink = true) {
  await page.goto(byLink ? `/join/${code}` : '/')
  if (!byLink) {
    await page.getByRole('tab', { name: 'Join a room' }).click()
    await page.getByLabel('Room code', { exact: true }).fill(code.toLowerCase())
  }
  await expect(page.getByRole('button', { name: 'Join room', exact: true })).toBeDisabled()
  await page.getByLabel('Your name', { exact: true }).fill(name)
  await page.getByRole('button', { name: 'Join room', exact: true }).click()
  await expect(page.getByRole('status').getByText('Connected', { exact: true })).toBeVisible()
}

async function send(page: Page, content: string) {
  const input = page.getByRole('textbox', { name: /^Message / })
  await input.fill(content)
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect(page.getByRole('log').getByText(content, { exact: true })).toBeVisible()
  await expect(input).toHaveValue('')
}

async function twoPeople(browser: Browser) {
  const contexts: BrowserContext[] = [await browser.newContext(), await browser.newContext()]
  const host = await contexts[0].newPage()
  const guest = await contexts[1].newPage()
  const code = await create(host)
  await join(guest, code)
  return { host, guest, code, close: () => Promise.all(contexts.map(context => context.close())) }
}

test('code-based entry, live text/code, typing, invitation copying, and reload', async ({ browser }) => {
  const first = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] })
  const second = await browser.newContext()
  const host = await first.newPage()
  const guest = await second.newPage()
  const errors: string[] = []
  host.on('pageerror', error => errors.push(error.message))
  guest.on('pageerror', error => errors.push(error.message))
  try {
    const code = await create(host)
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/)
    await join(guest, code, 'Bob', false)
    await host.getByRole('button', { name: 'Copy invitation link', exact: true }).click()
    expect(await host.evaluate(() => navigator.clipboard.readText())).toContain(`/join/${code}`)
    await guest.getByRole('textbox', { name: /^Message / }).fill('Thinking…')
    await expect(host.getByRole('status').filter({ hasText: 'Bob is typing' })).toBeVisible()
    await send(guest, 'Hello, everyone! 👋')
    await expect(host.getByRole('log').getByText('Hello, everyone! 👋', { exact: true })).toBeVisible()
    await guest.getByRole('button', { name: 'Code formatting', exact: true }).click()
    const snippet = "    const hello = '<script>not executed</script>';\n    console.log(hello);\n"
    await send(guest, snippet)
    await expect(host.locator('pre code')).toHaveText(snippet)
    await guest.reload()
    await expect(guest.locator('pre code')).toHaveText(snippet)
    await expect(guest.getByRole('region', { name: 'Host controls' })).toHaveCount(0)
    expect(errors).toEqual([])
  } finally { await first.close(); await second.close() }
})

test('host can lock entry, mute/unmute, and remove a guest', async ({ browser }) => {
  const { host, guest, code, close } = await twoPeople(browser)
  const lateContext = await browser.newContext()
  const late = await lateContext.newPage()
  try {
    await host.getByRole('button', { name: 'Lock room entry', exact: true }).click()
    await expect(host.getByRole('button', { name: 'Unlock room entry', exact: true })).toBeVisible()
    await late.goto(`/join/${code}`)
    await late.getByLabel('Your name', { exact: true }).fill('Carol')
    await late.getByRole('button', { name: 'Join room', exact: true }).click()
    await expect(late.getByRole('alert')).toContainText('locked')
    await guest.reload()
    await expect(guest.getByRole('status').getByText('Connected', { exact: true })).toBeVisible()
    await host.getByRole('button', { name: 'Toggle participants' }).click()
    await host.getByRole('button', { name: 'Mute Bob', exact: true }).click()
    await expect(guest.getByRole('status').filter({ hasText: 'The host has muted you' })).toBeVisible()
    await guest.getByRole('textbox', { name: /^Message / }).fill('A draft while muted')
    await expect(guest.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled()
    await host.getByRole('button', { name: 'Unmute Bob', exact: true }).click()
    await expect(guest.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled()
    await send(guest, 'Unmuted now')
    await host.getByRole('button', { name: 'Remove Bob', exact: true }).click()
    await host.getByRole('dialog').getByRole('button', { name: 'Remove participant', exact: true }).click()
    await expect(guest.getByRole('alert')).toContainText('removed')
    await guest.reload()
    await expect(guest.getByRole('alert')).toContainText('no longer valid')
    await host.getByRole('button', { name: 'Unlock room entry', exact: true }).click()
    await late.getByRole('button', { name: 'Join room', exact: true }).click()
    await expect(late.getByRole('status').getByText('Connected', { exact: true })).toBeVisible()
  } finally { await close(); await lateContext.close() }
})

test('ownership transfer updates both browsers and survives reload', async ({ browser }) => {
  const { host, guest, close } = await twoPeople(browser)
  try {
    await host.getByRole('button', { name: 'Toggle participants' }).click()
    await host.getByRole('button', { name: 'Make Bob host', exact: true }).click()
    await host.getByRole('dialog').getByRole('button', { name: 'Transfer host', exact: true }).click()
    await expect(host.getByRole('region', { name: 'Host controls' })).toHaveCount(0)
    await expect(guest.getByRole('region', { name: 'Host controls' })).toBeVisible()
    await guest.reload()
    await expect(guest.getByRole('button', { name: 'Lock room entry', exact: true })).toBeEnabled()
    await guest.getByRole('button', { name: 'Lock room entry', exact: true }).click()
    await expect(host.getByText('LOCKED', { exact: true })).toBeVisible()
  } finally { await close() }
})

test('ending retains a read-only transcript until host permanently deletes it', async ({ browser }) => {
  const { host, guest, code, close } = await twoPeople(browser)
  const lateContext = await browser.newContext()
  const late = await lateContext.newPage()
  try {
    await send(guest, 'These ideas should stay in the transcript.')
    await host.getByRole('button', { name: 'End meeting', exact: true }).click()
    await host.getByRole('dialog').getByRole('button', { name: 'End meeting', exact: true }).click()
    await expect(guest.getByText('READ-ONLY', { exact: true })).toBeVisible()
    await expect(guest.getByRole('textbox', { name: /^Message / })).toHaveCount(0)
    await guest.reload()
    await expect(guest.getByRole('log').getByText('These ideas should stay in the transcript.', { exact: true })).toBeVisible()
    const download = guest.waitForEvent('download')
    await guest.getByRole('button', { name: 'Export transcript', exact: true }).click()
    expect((await download).suggestedFilename()).toBe(`gather-${code}.txt`)
    await late.goto(`/join/${code}`)
    await late.getByLabel('Your name', { exact: true }).fill('Too late')
    await late.getByRole('button', { name: 'Join room', exact: true }).click()
    await expect(late.getByRole('alert')).toContainText('ended')
    await host.reload()
    await host.getByRole('button', { name: 'Delete room permanently', exact: true }).click()
    await host.getByRole('dialog').getByRole('button', { name: 'Delete room permanently', exact: true }).click()
    await expect(guest.getByRole('alert')).toContainText('deleted')
    await expect(host.getByRole('button', { name: 'Create room', exact: true })).toBeVisible()
  } finally { await close(); await lateContext.close() }
})

test('individual deletion and clearing update every participant', async ({ browser }) => {
  const { host, guest, close } = await twoPeople(browser)
  try {
    await send(guest, 'Delete this particular message')
    await send(guest, 'Keep this one for now')
    const article = host.getByRole('article').filter({ hasText: 'Delete this particular message' })
    await article.getByRole('button', { name: 'Delete message from Bob' }).click()
    await host.getByRole('dialog').getByRole('button', { name: 'Delete message', exact: true }).click()
    await expect(guest.getByRole('log').getByText('Delete this particular message', { exact: true })).toHaveCount(0)
    await expect(guest.getByRole('log').getByText('Keep this one for now', { exact: true })).toBeVisible()
    await host.getByRole('button', { name: 'Clear conversation', exact: true }).click()
    await host.getByRole('dialog').getByRole('button', { name: 'Clear messages', exact: true }).click()
    await expect(guest.getByRole('article')).toHaveCount(0)
    await guest.reload()
    await expect(guest.getByRole('status').getByText('Connected', { exact: true })).toBeVisible()
    await expect(guest.getByRole('article')).toHaveCount(0)
  } finally { await close() }
})

test('mobile navigation, sharing, leaving, and returning preserve the host session', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await create(page, 'A mobile meeting')
  await send(page, 'Hello from a little screen!')
  await page.getByRole('button', { name: 'Open navigation' }).click()
  await expect(page.getByRole('button', { name: 'Copy invitation link', exact: true })).toBeVisible()
  await page.getByRole('complementary', { name: 'Room navigation', exact: true }).getByRole('button', { name: /Participants/ }).click()
  await expect(page.getByRole('complementary', { name: 'Participants', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Close participants', exact: true }).click()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.getByRole('button', { name: 'Open navigation' }).click()
  await page.getByRole('button', { name: 'Leave meeting', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Leave for now', exact: true }).click()
  await page.getByRole('button').filter({ hasText: 'A mobile meeting' }).click()
  await expect(page.getByRole('log').getByText('Hello from a little screen!', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Open navigation' }).click()
  await expect(page.getByRole('region', { name: 'Host controls' })).toBeVisible()
})

test('a dropped WebSocket reconnects with the same session and draft', async ({ page }) => {
  let activeSocket: WebSocketRoute | undefined
  await page.routeWebSocket('**/api/ws/**', socket => {
    expect(new URL(socket.url()).search).toBe('')
    socket.connectToServer()
    activeSocket = socket
  })
  await create(page)
  await send(page, 'Saved before the disconnect')
  const input = page.getByRole('textbox', { name: /^Message / })
  await input.fill('A draft worth keeping')
  await activeSocket!.close({ code: 1012, reason: 'Testing reconnect' })
  await expect(page.getByText('Connection lost. Reconnecting automatically…', { exact: true })).toBeVisible()
  await expect(page.getByRole('status').getByText('Connected', { exact: true })).toBeVisible()
  await expect(input).toHaveValue('A draft worth keeping')
  await expect(page.getByRole('log').getByText('Saved before the disconnect', { exact: true })).toBeVisible()
  await send(page, 'A draft worth keeping')
  await expect(page.getByRole('log').getByText('A draft worth keeping', { exact: true })).toHaveCount(1)
})

test('joining your own invitation as a new guest never overwrites saved host access', async ({ page }) => {
  const code = await create(page, 'Multiple identities', 'Original Host')
  await join(page, code, 'Another Guest')
  await page.getByRole('button', { name: 'Leave meeting', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Leave for now', exact: true }).click()
  await expect(page.getByRole('button').filter({ hasText: 'Original Host · Host' })).toBeVisible()
  await expect(page.getByRole('button').filter({ hasText: 'Another Guest · Guest' })).toBeVisible()
  await page.getByRole('button').filter({ hasText: 'Original Host · Host' }).click()
  await expect(page.getByRole('region', { name: 'Host controls' })).toBeVisible()
})

test('earlier history can be loaded and large code snippets keep their formatting', async ({ page }) => {
  let socketUrl = ''
  page.on('websocket', socket => { socketUrl = socket.url() })
  await create(page, 'History test')
  await page.evaluate(async (url) => {
    const saved = JSON.parse(localStorage.getItem('gather.room-sessions.v2')!)[0]
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(url)
      let index = 0
      let expectedId = ''
      const timer = setTimeout(() => { socket.close(); reject(new Error('History seed timed out')) }, 10000)
      const sendNext = () => {
        expectedId = crypto.randomUUID()
        socket.send(JSON.stringify({ type: 'message', content: `History message ${index}`, kind: 'text', client_message_id: expectedId }))
      }
      socket.onopen = () => socket.send(JSON.stringify({ type: 'session', token: saved.token }))
      socket.onmessage = ({ data }) => {
        const event = JSON.parse(data)
        if (event.type === 'snapshot') sendNext()
        if (event.type === 'message' && event.message.client_message_id === expectedId) {
          index++
          if (index < 55) sendNext()
          else { clearTimeout(timer); socket.close(); resolve() }
        }
        if (event.type === 'error') { clearTimeout(timer); socket.close(); reject(new Error(event.message)) }
      }
      socket.onerror = () => { clearTimeout(timer); reject(new Error('History seed socket failed')) }
    })
  }, socketUrl)
  await page.reload()
  await expect(page.getByRole('button', { name: 'Load earlier messages', exact: true })).toBeVisible()
  await expect(page.getByRole('log').getByText('History message 0', { exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Load earlier messages', exact: true }).click()
  await expect(page.getByRole('log').getByText('History message 0', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Code formatting', exact: true }).click()
  const content = '    // preserved indentation\n' + 'x'.repeat(18000) + '\n'
  await send(page, content)
  expect(await page.locator('pre code').textContent()).toBe(content)
})
