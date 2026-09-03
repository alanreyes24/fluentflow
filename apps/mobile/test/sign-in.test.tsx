import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import SignInScreen from '../app/sign-in';
import { mockRouter, renderScreen } from './setup';

/**
 * Sign-in, registration and the offline escape hatch.
 *
 * "Continue without an account" is the path a first-time user takes, and the
 * one the app has to keep working when Firebase is unconfigured — which is the
 * state this repository ships in.
 */

async function fillCredentials(email: string, password: string) {
  await fireEvent.changeText(screen.getByLabelText('Email'), email);
  await fireEvent.changeText(screen.getByLabelText('Password'), password);
}

describe('SignInScreen', () => {
  it('lets someone start without an account', async () => {
    const { state } = await renderScreen(<SignInScreen />, { user: null });

    await fireEvent.press(screen.getByRole('button', { name: 'Continue without an account' }));

    expect(state.continueOffline).toHaveBeenCalled();
    expect(mockRouter.replace).toHaveBeenCalledWith('/(app)/decks');
  });

  it('hides the credential form when there is no cloud to sign in to', async () => {
    await renderScreen(<SignInScreen />, { cloudAvailable: false, user: null });

    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Continue without an account' })).toBeTruthy();
    expect(screen.getAllByText('Your cards stay on this device until you sign in.').length)
      .toBeGreaterThan(0);
  });

  it('refuses to submit until the credentials could plausibly be valid', async () => {
    const { state } = await renderScreen(<SignInScreen />, { user: null });

    const submit = screen.getByRole('button', { name: 'Sign in' });
    expect(submit.props.accessibilityState.disabled).toBe(true);

    // A password under six characters is rejected by Firebase anyway; failing
    // here saves a round trip and a confusing error.
    await fillCredentials('learner@example.com', 'short');
    expect(screen.getByRole('button', { name: 'Sign in' }).props.accessibilityState.disabled)
      .toBe(true);

    await fillCredentials('learner@example.com', 'long-enough');
    expect(screen.getByRole('button', { name: 'Sign in' }).props.accessibilityState.disabled)
      .toBe(false);
  });

  it('signs in and moves on', async () => {
    const { state } = await renderScreen(<SignInScreen />, { user: null });

    await fillCredentials('learner@example.com', 'correct-horse');
    await fireEvent.press(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => {
      expect(state.signIn).toHaveBeenCalledWith('learner@example.com', 'correct-horse');
      expect(mockRouter.replace).toHaveBeenCalledWith('/(app)/decks');
    });
  });

  it('switches to registration and registers', async () => {
    const { state } = await renderScreen(<SignInScreen />, { user: null });

    await fireEvent.press(screen.getByRole('button', { name: 'No account yet? Create one' }));
    await screen.findByRole('button', { name: 'Create account' });

    await fillCredentials('learner@example.com', 'correct-horse');
    await fireEvent.press(screen.getByRole('button', { name: 'Create account' }));

    await waitFor(() => {
      expect(state.register).toHaveBeenCalledWith('learner@example.com', 'correct-horse');
    });
  });

  it('turns a Firebase error code into something a person can act on', async () => {
    const { state } = await renderScreen(<SignInScreen />, {
      user: null,
      overrides: {
        signIn: jest.fn(async () => {
          throw Object.assign(new Error('Firebase: Error (auth/invalid-credential).'), {
            code: 'auth/invalid-credential',
          });
        }),
      },
    });

    await fillCredentials('learner@example.com', 'wrong-password');
    await fireEvent.press(screen.getByRole('button', { name: 'Sign in' }));

    // Not the raw code, and not a generic failure either.
    await screen.findByText('That email and password do not match an account.');
    expect(state.signIn).toHaveBeenCalled();
    expect(mockRouter.replace).not.toHaveBeenCalled();
  });

  it('suggests working offline when the network is the problem', async () => {
    await renderScreen(<SignInScreen />, {
      user: null,
      overrides: {
        signIn: jest.fn(async () => {
          throw Object.assign(new Error('network'), { code: 'auth/network-request-failed' });
        }),
      },
    });

    await fillCredentials('learner@example.com', 'correct-horse');
    await fireEvent.press(screen.getByRole('button', { name: 'Sign in' }));

    await screen.findByText(
      'No connection. You can continue without an account and sign in later.',
    );
  });
});
