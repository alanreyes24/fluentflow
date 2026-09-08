import { router } from 'expo-router';
import { useApp } from '../../src/state/app';
import { NewDeckForm } from '../../src/ui/NewDeckForm';
import { Page, Screen, Surface } from '../../src/ui/components';

export default function NewDeckScreen() {
  const { repository, user, refreshDecks } = useApp();

  return (
    <Screen>
      <Page maxWidth={560}>
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
      </Page>
    </Screen>
  );
}
