import { Pressable, StyleSheet, View } from 'react-native';
import { useI18n } from '../i18n';
import { useApp } from '../state/app';
import { Label } from './components';
import { useTheme } from './theme';

/**
 * The sync status pill in the header.
 *
 * It has to answer one question at a glance — "is my work safe?" — so the
 * pending count is shown whenever it is non-zero, even while syncing. A bare
 * "Synced" with three unsent reviews behind it is the failure mode worth
 * designing against.
 */
export function SyncIndicator({ compact = false }: { compact?: boolean }) {
  const theme = useTheme();
  const { t } = useI18n();
  const { sync, syncNow, user, cloudAvailable } = useApp();

  if (!user) return null;

  // Nothing to indicate when there is no cloud to sync with; the offline note
  // on the sign-in screen already covers that case.
  if (!cloudAvailable || user.anonymous) {
    return (
      <View style={styles.container}>
        <Dot color={theme.colors.offline} />
        {!compact ? <Label variant="caption" tone="faint">{t('offline')}</Label> : null}
      </View>
    );
  }

  const { color, text } = describe();

  function describe(): { color: string; text: string } {
    if (sync.pending > 0 && sync.state !== 'syncing') {
      return { color: theme.colors.statusLearning, text: t('pendingChanges', { count: sync.pending }) };
    }
    switch (sync.state) {
      case 'syncing':
        return { color: theme.colors.accent, text: t('syncing') };
      case 'offline':
        return { color: theme.colors.offline, text: t('offline') };
      case 'error':
        return { color: theme.colors.danger, text: t('syncFailed') };
      default:
        return { color: theme.colors.statusMastered, text: t('synced') };
    }
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${text}. ${t('syncNow')}`}
      onPress={() => void syncNow()}
      style={({ pressed }) => [styles.container, { opacity: pressed ? 0.6 : 1 }]}
    >
      <Dot color={color} />
      {!compact ? <Label variant="caption" tone="muted">{text}</Label> : null}
    </Pressable>
  );
}

function Dot({ color }: { color: string }) {
  return (
    <View
      style={[
        styles.dot,
        { backgroundColor: color, boxShadow: `0 0 0 3px ${withAlpha(color, '2e')}` },
      ]}
    />
  );
}

/** Append an alpha byte to a `#rrggbb`; leave rgba()/keywords alone. */
function withAlpha(color: string, alpha: string): string {
  return /^#[0-9a-fA-F]{6}$/.test(color) ? `${color}${alpha}` : color;
}

const styles = StyleSheet.create({
  container: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 8, minWidth: 24 },
  dot: { width: 7, height: 7, borderRadius: 3.5 },
});
