import {
  DATA_PERMISSION_LABELS,
  type DataPermissionId,
  type PermissionDecision,
} from '../contracts';

import { useAdvancedConnections } from './hooks/useAdvancedConnections';
import { AdvancedConnectionsSection } from './ui/AdvancedConnectionsSection';

export function AdvancedConnectionsFeature(): React.JSX.Element {
  const state = useAdvancedConnections();

  const handlePermissionChange = (
    connectionId: string,
    permissionId: DataPermissionId,
    decision: PermissionDecision
  ): void => {
    const metadata = DATA_PERMISSION_LABELS[permissionId];
    if (
      decision === 'granted' &&
      metadata.risk === 'high' &&
      !window.confirm(`确认允许“${metadata.label}”吗？\n\n${metadata.description}`)
    ) {
      return;
    }
    void state.setPermission(connectionId, permissionId, decision);
  };

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
      onPermissionChange={handlePermissionChange}
      onSyncConnection={(connectionId) => void state.syncConnection(connectionId)}
      onPullRemoteTasks={(connectionId) => void state.pullRemoteTasks(connectionId)}
      onCheckTokenCatalog={(connectionId) => void state.checkTokenCatalog(connectionId)}
      onRefresh={() => void state.refresh()}
    />
  );
}
