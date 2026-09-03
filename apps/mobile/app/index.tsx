import { Redirect } from 'expo-router';
import { useApp } from '../src/state/app';

/** Entry point: straight to the decks if signed in, otherwise to sign-in. */
export default function Index() {
  const { user } = useApp();
  return <Redirect href={user ? '/(app)/decks' : '/sign-in'} />;
}
