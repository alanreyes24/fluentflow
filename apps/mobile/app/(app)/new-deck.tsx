import { ScrollView } from 'react-native';
import { router } from 'expo-router';
import { useApp } from '../../src/state/app';
import { NewDeckForm } from '../../src/ui/NewDeckForm';
import { AnkiImportPanel } from './import';
import { Screen, Spacer, Surface, useContentStyle } from '../../src/ui/components';

export default function NewDeckScreen() {
  const content = useContentStyle({ maxWidth: 560 });
  const { repository, user, refreshDecks } = useApp();

  return (
    <Screen>
      <ScrollView contentContainerStyle={content}>
        <Surface>
          <NewDeckForm
            onCancel={() => router.back()}
            onCreate={async (name, language) => {
              if (!repository || !user) return;
              const deck = await repository.createDeck(user.id, name, language);
              await refreshDecks();
              router.replace({ pathname: '/(app)/deck/[id]', params: { id: deck.id } });
            }}
          />
        </Surface>
        <Spacer />
        <AnkiImportPanel embedded />
      </ScrollView>
    </Screen>
  );
}
