import { render, screen } from '@testing-library/react';
import App from './App';

test('renders scoreboard clock', () => {
  render(<App />);
  expect(screen.getByText(/00:00/)).toBeInTheDocument();
});
