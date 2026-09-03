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
export function SyncIndicator() {
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
        <Label variant="caption" tone="faint">
          {t('offline')}
        </Label>
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
      <Label variant="caption" tone="muted">
        {text}
      </Label>
    </Pressable>
  );
}

function Dot({ color }: { color: string }) {
  return <View style={[styles.dot, { backgroundColor: color }]} />;
}

const styles = StyleSheet.create({
  container: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 8 },
  dot: { width: 8, height: 8, borderRadius: 4 },
});
