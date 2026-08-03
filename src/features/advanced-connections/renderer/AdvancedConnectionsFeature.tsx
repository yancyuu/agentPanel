import { useAdvancedConnections } from './hooks/useAdvancedConnections';
import { AdvancedConnectionsSection } from './ui/AdvancedConnectionsSection';

export function AdvancedConnectionsFeature(): React.JSX.Element {
  const state = useAdvancedConnections();

  return (
    <AdvancedConnectionsSection
      connections={state.connections}
      host={state.host}
      preview={state.preview}
      loading={state.loading}
      busyAction={state.busyAction}
      error={state.error}
      notice={state.notice}
      catalogStatus={state.catalogStatus}
      claimSteps={state.claimSteps}
      claimModels={state.claimModels}
      channelStatus={state.channelStatus}
      onHostChange={state.setHost}
      onDiscover={() => void state.discover()}
      onAddConnection={() => void state.addConnection()}
      onRemoveConnection={(connectionId) => {
        if (window.confirm('删除连接后，本机保存的该连接授权也会被清除。确认删除吗？')) {
          void state.removeConnection(connectionId);
        }
      }}
      onStartAuth={(connection) => void state.startAuth(connection)}
      onLogout={(connectionId) => void state.logout(connectionId)}
      onAllowInsecure={(connectionId) => void state.allowInsecure(connectionId)}
      onSetUsageReporting={(connectionId, enabled) =>
        void state.setUsageReporting(connectionId, enabled)
      }
      onPullRemoteTasks={(connectionId) => void state.pullRemoteTasks(connectionId)}
      onClaimAndApplyToken={(connectionId) => {
        if (
          window.confirm(
            '确认从 Token 池领取凭证并写入本机 Claude Code、Codex 和 Pi 配置吗？\n\n明文 Token 只会在后端短暂处理，不会显示在页面中。'
          )
        ) {
          void state.claimAndApplyToken(connectionId);
        }
      }}
      onConfirmClaimModel={(connectionId, model) =>
        void state.confirmClaimModel(connectionId, model)
      }
      onCancelTokenClaim={(connectionId) => void state.cancelTokenClaim(connectionId)}
      onRefresh={() => void state.refresh()}
    />
  );
}
