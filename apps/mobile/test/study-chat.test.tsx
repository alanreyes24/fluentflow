import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { StudyChat } from '../src/ui/StudyChat';
import { sendChat } from '../src/ai/desktop';
import { renderScreen } from './setup';

jest.mock('../src/ai/desktop', () => ({ sendChat: jest.fn() }));
const send = jest.mocked(sendChat);
const card = {
  front: 'casa', back: 'house', language: 'es' as const,
  examples: ['Esta es mi casa.'], grammarNotes: ['Feminine noun'], relatedWords: ['hogar'],
};

beforeEach(() => send.mockReset());

test('keeps conversation when collapsed and sends follow-up history', async () => {
  send.mockResolvedValueOnce('House.').mockResolvedValueOnce('Casas.');
  const view = await renderScreen(<StudyChat open={true} onClose={jest.fn()} card={card} />);
  await fireEvent.changeText(screen.getByLabelText('Your question'), 'What is casa?');
  await fireEvent.press(screen.getByRole('button', { name: 'Send' }));
  await screen.findByText('House.');
  await view.rerender(<StudyChat open={false} onClose={jest.fn()} card={card} />);
  await view.rerender(<StudyChat open={true} onClose={jest.fn()} card={card} />);
  await fireEvent.changeText(screen.getByLabelText('Your question'), 'And the plural?');
  await fireEvent.press(screen.getByRole('button', { name: 'Send' }));
  await screen.findByText('Casas.');
  expect(send).toHaveBeenLastCalledWith([
    { role: 'user', text: expect.stringContaining('Question: What is casa?') },
    { role: 'model', text: 'House.' },
    { role: 'user', text: expect.stringContaining('Question: And the plural?') },
  ]);
});

test('restores a failed question so it can be retried without duplicate history', async () => {
  send.mockRejectedValueOnce(new Error('Quota exceeded')).mockResolvedValueOnce('Hello.');
  await renderScreen(<StudyChat open={true} onClose={jest.fn()} card={card} />);
  await fireEvent.changeText(screen.getByLabelText('Your question'), 'Hi');
  await fireEvent.press(screen.getByRole('button', { name: 'Send' }));
  await screen.findByText('Quota exceeded');
  await waitFor(() => expect(screen.getByLabelText('Your question').props.value).toBe('Hi'));
  await fireEvent.press(screen.getByRole('button', { name: 'Send' }));
  await screen.findByText('Hello.');
  expect(send).toHaveBeenLastCalledWith([{ role: 'user', text: expect.stringContaining('Question: Hi') }]);
});


test('uses the new card context on the next question while keeping earlier context', async () => {
  send.mockResolvedValueOnce('A feminine noun.').mockResolvedValueOnce('A masculine noun.');
  const view = await renderScreen(<StudyChat open={true} onClose={jest.fn()} card={card} />);
  await fireEvent.changeText(screen.getByLabelText('Your question'), 'Explain this word');
  await fireEvent.press(screen.getByRole('button', { name: 'Send' }));
  await screen.findByText('A feminine noun.');
  const first = send.mock.calls[0]![0][0]!.text;
  for (const context of ['casa', 'house', 'Spanish (es)', 'Esta es mi casa.', 'Feminine noun', 'hogar']) {
    expect(first).toContain(context);
  }

  await view.rerender(<StudyChat open={true} onClose={jest.fn()} card={{ ...card, front: 'pas', back: 'dog', language: 'bs',
    examples: ['Ovo je moj pas.'], grammarNotes: [], relatedWords: [] }} />);
  await screen.findByText('pas · Bosanski');
  await fireEvent.changeText(screen.getByLabelText('Your question'), 'And this word?');
  await fireEvent.press(screen.getByRole('button', { name: 'Send' }));
  await screen.findByText('A masculine noun.');
  const history = send.mock.calls[1]![0];
  expect(history[0]!.text).toBe(first);
  expect(history[2]!.text).toContain('Bosnian (bs)');
  expect(history[2]!.text).toContain('Ovo je moj pas.');
  expect(history[2]!.text).toContain('dog');
  expect(history[2]!.text).not.toContain('casa');
});


test('renders formatted replies with headings, emphasis, lists, and table cells', async () => {
  send.mockResolvedValue('### Common uses\n\n**Matutina** means *morning*.\n\n* La rutina matutina\n* La luz matutina\n\n| Everyday | Formal |\n| --- | --- |\n| De la mañana | Matutino |');
  await renderScreen(<StudyChat open={true} onClose={jest.fn()} card={card} />);
  await fireEvent.changeText(screen.getByLabelText('Your question'), 'How is it used?');
  await fireEvent.press(screen.getByRole('button', { name: 'Send' }));
  await screen.findByText('Common uses');
  expect(screen.getByText('Matutina')).toHaveStyle({ fontWeight: 'bold' });
  expect(screen.getByText('morning')).toHaveStyle({ fontStyle: 'italic' });
  expect(screen.getByText('La rutina matutina')).toBeTruthy();
  expect(screen.getByText('Everyday')).toBeTruthy();
  expect(screen.getByText('De la mañana')).toBeTruthy();
  expect(screen.queryByText(/###|\*\*|\| ---/)).toBeNull();
});
