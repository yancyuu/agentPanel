import { HttpAPIClient } from './httpClient';

import type { ElectronAPI } from '@shared/types/api';

function getHttpBaseUrl(): string {
  // 显式 ?port=xxxx 优先(本机调试用)
  const params = new URLSearchParams(window.location.search);
  const explicitPort = params.get('port');
  if (explicitPort) {
    return `http://127.0.0.1:${parseInt(explicitPort, 10)}`;
  }
  // 默认同源:
  //   - 生产 / `pnpm start:server`: 后端 5680 直接托管 dist-renderer,同源
  //   - dev(`pnpm dev:mvp`): 前端 vite 5174,vite.web.config 已把 /api 代理到 5680
  // 同源 fetch 既能用 SSE,也不存在 CORS 问题。
  return window.location.origin;
}

export interface RendererApiCapabilities {
  taskCommentAttachments: {
    available: boolean;
    unavailableReason?: string;
  };
}

export const rendererApiCapabilities: RendererApiCapabilities = {
  taskCommentAttachments: {
    available: false,
    unavailableReason: '浏览器模式暂不支持评论附件',
  },
};

export const api: ElectronAPI = new HttpAPIClient(getHttpBaseUrl());
