import { createElement, type ComponentProps } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { WelfareTab } from '../src/client/CodeArtsCard.tsx'
import { dictionaries } from '../src/client/locales.ts'

type Status = NonNullable<ComponentProps<typeof WelfareTab>['status']>
type Welfare = NonNullable<Status['welfare']>

const daily = { campaignId: 91, title: '每日签到', type: 'USER_LOGIN', claimable: false }
const registration = {
  campaignId: 92,
  title: '新用户注册奖励',
  type: 'NEW_USER_REGISTER',
  claimable: false,
  benefitAmount: 4000,
  benefitUnit: 'CREDIT',
}

const render = (items: Welfare['items'], error: Welfare['error'] = null): string =>
  renderToStaticMarkup(createElement(WelfareTab, {
    status: {
      version: 'fixture',
      credential: { signedIn: false, error: null },
      catalog: { total: 0, fetchedAt: 0, error: null, models: [] },
      account: null,
      credit: null,
      welfare: { items, error, fetchedAt: 1 },
    },
    t: (key) => dictionaries.zh[key as keyof typeof dictionaries.zh] ?? key,
    busy: false,
    onClaim: () => {},
    claimBusy: undefined,
    claimMessage: undefined,
    onAutoCheckinChange: () => {},
    autoCheckinSaving: false,
    autoCheckinError: undefined,
  }))

describe('签到与福利状态', () => {
  it.each(['CLAIMED', 'CONFIRMED', 'CONSUMED'])('区分 %s 的签到和注册奖励', (status) => {
    const html = render([{ ...daily, status }, { ...registration, status }])
    const [dailyRow, registrationRow] = html.match(/<div class="dsc-row">.*?<\/div>/g) ?? []
    expect(dailyRow).toContain('>每日签到</span>')
    expect(dailyRow).toContain('>今日已签</span>')
    expect(registrationRow).toContain('>新用户注册奖励</span>')
    expect(registrationRow).toContain('>4,000 积分</span>')
    expect(registrationRow).toContain('>已领</span>')
    expect(html).not.toContain('>领取</button>')
  })

  it.each([true, false])('显示未签，只有允许领取时显示按钮（%s）', (claimable) => {
    const html = render([{ ...daily, status: 'ELIGIBLE', claimable }])
    expect(html).toContain('>今日未签</span>')
    expect(html.includes('>领取</button>')).toBe(claimable)
    expect(html).not.toContain('新用户注册奖励')
  })

  it('日签状态缺失时显示待确认', () => {
    const html = render([daily])
    expect(html).toContain('>状态待确认</span>')
    expect(html).not.toContain('>今日未签</span>')
  })

  it('读取失败后缓存的状态不会当成当前状态或开放领取', () => {
    const html = render([
      { ...daily, status: 'CLAIMED' },
      { ...registration, status: 'ELIGIBLE', claimable: true },
    ], '读取失败')
    expect(html.match(/>状态待确认<\/span>/g)).toHaveLength(2)
    expect(html).not.toContain('>今日已签</span>')
    expect(html).not.toContain('>领取</button>')
  })
})
