import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { mockRancher, fixtureState } from '../test/fixture.js'

const cli = process.env.DSH_CLI || 'dsh'
const version = JSON.parse(await readFile('package.json', 'utf8')).version
await mkdir('work', { recursive: true })
const env = { ...process.env, DSH_HOME: await mkdtemp(path.resolve('work/dsh-smoke-')) }
const fixture = await mockRancher()
const secondaryState = fixtureState()
secondaryState.nodes = secondaryState.nodes.slice(0, 2).map((node, index) => ({ ...node, metadata: { ...node.metadata, name: `stage-worker-0${index + 1}`, uid: `uid-stage-${index}` } }))
const secondary = await mockRancher({ state: secondaryState })
let host, browser
try {
  const install = spawn(cli, ['plugin', '--profile', 'web', 'add', `file:${path.resolve(`dsh-rancher-${version}.tgz`)}`], { env, stdio: 'pipe' })
  await new Promise((resolve, reject) => {
    install.on('error', reject)
    install.on('exit', code => code === 0 ? resolve() : reject(new Error(`DSH isolated install failed: ${code}`)))
  })
  host = spawn(cli, ['--profile', 'web', '--port', '0', '--no-open'], { env, stdio: 'pipe' })
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('DSH startup timed out')), 30000)
    let stdout = ''
    host.stdout.on('data', data => {
      stdout += data
      const match = stdout.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+/)
      if (match) { clearTimeout(timer); resolve(match[0]) }
    })
    host.on('error', error => { clearTimeout(timer); reject(error) })
    host.on('exit', code => { clearTimeout(timer); reject(new Error(`DSH exited during startup: ${code}`)) })
  })
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : { channel: 'chrome' }) })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  const choose = async (label, option, root = page) => {
    await root.getByRole('button', { name: label, exact: true }).click()
    await page.getByRole('menuitem', { name: option, exact: true }).click()
  }
  await page.goto(url)
  const onboarding = page.getByRole('button', { name: '继续', exact: true })
  await onboarding.waitFor({ state: 'visible' })
  await onboarding.click()
  await page.getByRole('button', { name: '稍后配置', exact: true }).click()
  await page.getByRole('button', { name: 'Rancher', exact: true }).waitFor()
  await page.getByText('设置', { exact: true }).first().click()
  await page.getByText('Rancher', { exact: true }).last().click()
  await page.getByRole('heading', { name: 'Rancher 连接设置', exact: true }).waitFor()
  assert.equal(await page.locator('.rc-table').count(), 0)
  assert.equal(await page.getByRole('tab', { name: '节点', exact: true }).count(), 0)
  await page.getByRole('button', { name: '添加连接', exact: true }).click()
  assert.match(await page.getByRole('dialog', { name: '添加 Rancher 连接' }).getAttribute('class'), /_dialog_/)
  assert.match(await page.getByRole('textbox', { name: '连接名称', exact: true }).locator('..').getAttribute('class'), /_wrap_/)
  await page.getByRole('textbox', { name: '连接名称', exact: true }).fill('Host smoke')
  await page.getByRole('textbox', { name: 'Rancher URL', exact: true }).fill(fixture.url)
  await page.locator('input[type=password]').fill('fixture-token')
  await page.getByRole('checkbox', { name: '启用管理操作', exact: false }).check()
  await page.getByRole('button', { name: '保存连接', exact: true }).click()
  await page.getByRole('button', { name: '确认保存', exact: true }).click()
  await page.getByRole('dialog', { name: '添加 Rancher 连接' }).waitFor({ state: 'detached' })
  await page.getByRole('button', { name: '打开 Host smoke', exact: true }).click()
  await page.getByRole('heading', { name: 'Rancher 工作台', exact: true }).waitFor()
  await page.getByRole('cell', { name: 'worker-01', exact: true }).waitFor()
  assert.match(await page.getByRole('button', { name: 'Rancher 连接', exact: true }).getAttribute('class'), /_button_/)
  assert.match(await page.getByRole('button', { name: 'Rancher 连接', exact: true }).locator('..').getAttribute('class'), /_root_/)
  assert.match(await page.getByRole('tab', { name: '节点', exact: true }).getAttribute('class'), /_tab_/)
  assert.equal(await page.locator('select').count(), 0)
  assert.equal(await page.getByRole('button', { name: '封锁节点', exact: true }).first().isDisabled(), false)
  await page.locator('.rc-usage').getByText('250m', { exact: true }).waitFor()
  await page.getByRole('tab', { name: 'Pods', exact: true }).click()
  await page.getByRole('button', { name: '命名空间', exact: true }).click()
  const namespaceSearch = page.getByRole('textbox', { name: '搜索命名空间', exact: true })
  assert.match(await namespaceSearch.locator('..').getAttribute('class'), /_wrap_/)
  await namespaceSearch.fill('kube')
  const namespaceOption = page.getByRole('menuitem', { name: 'kube-system', exact: true })
  assert.match(await namespaceOption.getAttribute('class'), /_item_/)
  await namespaceOption.click()
  await page.getByRole('button', { name: '完成选择', exact: true }).click()
  await page.getByRole('button', { name: 'coredns-6b6889-q2z7r', exact: true }).waitFor()
  assert.equal(await page.locator('.rc-table tbody tr').count(), 1)
  await page.getByRole('button', { name: '命名空间', exact: true }).click()
  await page.getByRole('menuitem', { name: 'production', exact: true }).click()
  await page.getByRole('button', { name: '完成选择', exact: true }).click()
  await page.getByRole('button', { name: 'api-7f44b8-x2k9p', exact: true }).waitFor()
  assert.equal(await page.locator('.rc-table tbody tr').count(), 5)
  await choose('Pod 分组', '按命名空间分组')
  assert.equal(await page.locator('.rc-group-row').count(), 2)
  await page.locator('.rc-group-row').getByRole('button', { name: 'production', exact: true }).click()
  assert.equal(await page.locator('.rc-tree-child').count(), 1)
  await page.getByRole('button', { name: '展开全部分组', exact: true }).click()
  await mkdir('work/screenshots', { recursive: true })
  await page.screenshot({ path: 'work/screenshots/dsh-host-tree.png', fullPage: true })
  await page.getByRole('button', { name: '查看 api-7f44b8-x2k9p 日志与详情', exact: true }).click()
  await page.getByLabel('Pod 日志', { exact: true }).filter({ hasText: 'live line 2' }).waitFor()
  const hostDialog = page.getByRole('dialog')
  const hostHandle = page.getByRole('separator', { name: '调整 Pod 窗口宽度' })
  const hostStart = await hostDialog.boundingBox()
  const hostGrip = await hostHandle.boundingBox()
  await page.mouse.move(hostGrip.x + 4, hostGrip.y + hostGrip.height / 2)
  await page.mouse.down()
  await page.mouse.move(hostGrip.x - 100, hostGrip.y + hostGrip.height / 2, { steps: 5 })
  await page.mouse.up()
  assert.ok((await hostDialog.boundingBox()).width > hostStart.width + 90, 'DSH modal must resize from its left edge')
  assert.match(await page.getByRole('textbox', { name: '搜索日志' }).locator('..').getAttribute('class'), /_wrap_/)
  await page.getByRole('button', { name: '暂停日志', exact: true }).click()
  await page.getByRole('status').filter({ hasText: '已暂停' }).waitFor()
  await page.getByRole('button', { name: '继续跟随', exact: true }).click()
  await page.getByRole('status').filter({ hasText: '实时跟随中' }).waitFor()
  await page.getByLabel('Pod 日志', { exact: true }).filter({ hasText: 'live line 2' }).waitFor()
  await page.screenshot({ path: 'work/screenshots/dsh-host-live-logs.png', fullPage: true })
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  await choose('Pod 分组', '按节点分组')
  assert.equal(await page.locator('.rc-group-row').count(), 3)
  await page.getByRole('button', { name: '删除 api-7f44b8-x2k9p', exact: true }).click()
  await page.getByRole('dialog').getByText('Host smoke · production-rke2', { exact: true }).waitFor()
  await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click()
  assert.equal(fixture.state.calls.some(call => call.method === 'DELETE'), false)
  await page.getByRole('tab', { name: '命名空间', exact: true }).click()
  await page.getByRole('cell', { name: 'production', exact: true }).waitFor()
  assert.equal(await page.getByRole('button', { name: '命名空间', exact: true }).isDisabled(), true)
  await page.getByRole('tab', { name: '节点', exact: true }).click()

  await page.getByRole('button', { name: '连接设置', exact: true }).click()
  await page.getByRole('button', { name: '添加连接', exact: true }).click()
  const passwordDialog = page.getByRole('dialog', { name: '添加 Rancher 连接' })
  await choose('认证方式', '账户密码', passwordDialog)
  await passwordDialog.getByRole('textbox', { name: '连接名称', exact: true }).fill('Host password')
  await passwordDialog.getByRole('textbox', { name: 'Rancher URL', exact: true }).fill(secondary.url)
  await passwordDialog.getByRole('textbox', { name: 'Rancher 用户名', exact: true }).fill('fixture-user')
  await passwordDialog.locator('input[type=password]').fill('fixture-password')
  await passwordDialog.getByRole('button', { name: '保存连接', exact: true }).click()
  await page.getByRole('button', { name: '确认保存', exact: true }).click()
  await passwordDialog.waitFor({ state: 'detached' })
  await page.getByRole('status').filter({ hasText: 'Host password：连接验证通过' }).waitFor()
  await page.getByRole('button', { name: '打开 Host password', exact: true }).click()
  await choose('Rancher 连接', 'Host password · 只读')
  await page.getByRole('tab', { name: '节点', exact: true }).click()
  await page.getByRole('cell', { name: 'stage-worker-01', exact: true }).waitFor()
  assert.equal(await page.locator('.rc-table tbody tr').count(), 2)
  assert.equal(await page.getByRole('cell', { name: 'worker-01', exact: true }).count(), 0)
  assert.equal(await page.getByRole('button', { name: '封锁节点', exact: true }).first().isDisabled(), true)

  assert.ok(secondary.state.calls.some(call => call.path === '/v3-public/localProviders/local' && call.body?.username === 'fixture-user'))
  assert.ok(secondary.state.calls.some(call => call.path.endsWith('/nodes') && call.authorization === 'Bearer fixture-session-token'))
  const rowHeight = await page.locator('.rc-table tbody tr').first().evaluate(row => row.getBoundingClientRect().height)
  assert.ok(rowHeight <= 40, `Embedded table row too tall: ${rowHeight}`)
  const actionBox = await page.getByRole('button', { name: '封锁节点', exact: true }).first().boundingBox()
  const tableBox = await page.locator('.rc-table-wrap').boundingBox()
  assert.ok(actionBox.x >= tableBox.x && actionBox.x + actionBox.width <= tableBox.x + tableBox.width + 1, 'Actions must remain visible without horizontal scrolling')
  const themeChecks = []
  for (const [hostDark, systemScheme] of [[false, 'dark'], [true, 'light']]) {
    await page.emulateMedia({ colorScheme: systemScheme })
    const colors = await page.locator('.rc-workbench').evaluate((root, dark) => {
      document.body.toggleAttribute('data-ds-dark-theme', dark)
      const probe = document.createElement('span')
      probe.style.backgroundColor = 'var(--dsw-alias-bg-base)'
      probe.style.color = 'var(--dsw-alias-label-primary)'
      root.appendChild(probe)
      const actual = getComputedStyle(root)
      const expected = getComputedStyle(probe)
      const colors = { background: actual.backgroundColor, foreground: actual.color, hostBackground: expected.backgroundColor, hostForeground: expected.color, bodyDark: document.body.hasAttribute('data-ds-dark-theme') }
      probe.remove()
      return colors
    }, hostDark)
    assert.equal(colors.background, colors.hostBackground, 'Workbench must use the host background regardless of system theme')
    assert.equal(colors.foreground, colors.hostForeground, 'Workbench must use the host foreground regardless of system theme')
    themeChecks.push({ hostDark, systemScheme, ...colors })
  }
  assert.notEqual(themeChecks[0].background, themeChecks[1].background)
  await page.emulateMedia({ colorScheme: 'light' })
  await page.evaluate(() => document.body.removeAttribute('data-ds-dark-theme'))
  await mkdir('work/screenshots', { recursive: true })
  await page.screenshot({ path: 'work/screenshots/dsh-host.png', fullPage: true, animations: 'disabled' })
  await page.getByRole('button', { name: 'Rancher', exact: true }).click()
  await page.getByRole('cell', { name: 'stage-worker-01', exact: true }).waitFor()
  const api = await page.evaluate(async () => {
    const response = await fetch('/api/rancher/connections')
    return { status: response.status, payload: await response.text() }
  })
  assert.equal(api.status, 200)
  assert.equal(api.payload.includes('fixture-token'), false)
  assert.equal(api.payload.includes('fixture-password'), false)
  const installedVersion = JSON.parse(await readFile(path.join(env.DSH_HOME, 'profiles/web/node_modules/dsh-rancher/package.json'), 'utf8')).version
  assert.equal(installedVersion, version)
  assert.deepEqual(errors, [])
  await writeFile('work/host-results.json', JSON.stringify({ passed: true, installedVersion, installedProfile: env.DSH_HOME, hostControls: true, hostNamespaceSearchControls: true, namespaceFiltering: true, namespaceResourcePage: true, cpuMemoryMetrics: true, sidebarWorkbench: true, settingsOnlyConnections: true, settingsToWorkbench: true, multipleRancherServers: true, independentManagementPermissions: true, authenticatedApi: true, passwordLogin: true, passwordNodeRead: true, compactRowHeight: rowHeight, themeChecks, realHttpFixture: true, browserErrors: errors }, null, 2) + '\n')
  console.log('PASS: DSH sidebar workbench, separate connection settings, two Rancher servers, authenticated API and independent management permissions')
} catch (error) {
  const page = browser?.contexts()[0]?.pages()[0]
  if (page) {
    await mkdir('work/screenshots', { recursive: true })
    await page.screenshot({ path: 'work/screenshots/host-failure.png', fullPage: true }).catch(() => {})
  }
  throw error
} finally {
  await browser?.close()
  if (host && host.exitCode === null) {
    const exited = new Promise(resolve => host.once('exit', resolve))
    host.kill('SIGTERM')
    await exited
  }
  await fixture.close()
  await secondary.close()
}
