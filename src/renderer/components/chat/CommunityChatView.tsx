import React from 'react';

import { MessageCircle, QrCode, Sparkles, Users } from 'lucide-react';

const COMMUNITY_QR_IMAGE = '/chat-community-qr.jpg';

export const CommunityChatView = (): React.JSX.Element => {
  return (
    <div className="relative flex-1 overflow-auto bg-surface">
      <div
        className="pointer-events-none absolute inset-x-0 top-0 h-[520px] bg-[radial-gradient(ellipse_80%_50%_at_50%_-20%,rgba(132,204,22,0.14),transparent)]"
        aria-hidden="true"
      />

      <div className="relative mx-auto flex min-h-full max-w-5xl flex-col px-8 py-12">
        <section className="overflow-hidden rounded-2xl border border-border bg-surface-raised shadow-sm">
          <div className="border-b border-border bg-gradient-to-br from-lime-500/15 via-emerald-500/10 to-transparent p-8">
            <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-lime-500/25 bg-lime-500/10 px-3 py-1 text-[11px] font-medium text-lime-300">
              <MessageCircle className="size-3.5" />
              Chat / 交流圈
            </div>
            <h1 className="text-3xl font-semibold tracking-tight text-text">加入 Yancy 的朋友们</h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-text-secondary">
              扫码加入「野生想法」交流圈，聊 Loop Engineering、Agent
              Teams、自动化工作台和一人公司的实践。
            </p>
          </div>

          <div className="grid gap-8 p-8 lg:grid-cols-[minmax(0,1fr)_360px]">
            <div className="space-y-4">
              <div className="rounded-xl border border-border bg-surface px-5 py-4">
                <div className="mb-2 flex items-center gap-2 text-sm font-medium text-text">
                  <Users className="size-4 text-lime-400" />
                  适合谁加入
                </div>
                <p className="text-sm leading-6 text-text-muted">
                  如果你正在用 Claude Code / AgentPanel / 多 Agent 团队做真实项目，或者想交流 AI
                  自动化、产品工程和独立创造，这里会持续分享实验和想法。
                </p>
              </div>

              <div className="rounded-xl border border-border bg-surface px-5 py-4">
                <div className="mb-2 flex items-center gap-2 text-sm font-medium text-text">
                  <Sparkles className="size-4 text-emerald-400" />
                  你可以期待
                </div>
                <ul className="space-y-2 text-sm leading-6 text-text-muted">
                  <li>• AgentPanel 的功能讨论和使用反馈</li>
                  <li>• Agent 团队、Loop、Workflow 的实践案例</li>
                  <li>• 一人公司、自动化研发和产品想法交流</li>
                </ul>
              </div>

              <div className="rounded-xl border border-lime-500/20 bg-lime-500/5 px-5 py-4 text-sm leading-6 text-lime-100/90">
                备注：该二维码来自飞书 / Lark 圈子，仅限企业内部成员加入；如果扫码不可用，请联系
                Yancy 获取新的邀请方式。
              </div>
            </div>

            <div className="rounded-2xl border border-border bg-surface p-5 text-center">
              <div className="mb-3 inline-flex items-center gap-2 text-sm font-medium text-text">
                <QrCode className="size-4 text-lime-400" />
                扫码加入
              </div>
              <div className="rounded-2xl border border-border bg-white p-3 shadow-sm">
                <img
                  src={COMMUNITY_QR_IMAGE}
                  alt="Yancy 的朋友们交流圈二维码"
                  className="mx-auto aspect-square w-full rounded-xl object-cover"
                />
              </div>
              <p className="mt-4 text-xs leading-5 text-text-muted">
                打开飞书 / Lark 扫一扫，加入「Yancy 的朋友们 · 野生想法」。
              </p>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
};
