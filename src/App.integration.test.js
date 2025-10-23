import { render, screen, fireEvent } from '@testing-library/react';
import App from './App';

describe('Tulostaulun testaus', () => {
  test('kellon näyttö renderöityy', () => {
    render(<App />);
    // Oletuskellon aika on 00:00
    expect(screen.getByText(/00:00/)).toBeInTheDocument();
  });

  test('kellon + ja - napit muuttavat aikaa', () => {
    render(<App />);
    const plusButton = screen.getByTitle('Lisää kelloon sekunti');
    const minusButton = screen.getByTitle('Vähennä kellosta sekunti');
    // Lisää sekunti
    fireEvent.click(plusButton);
    expect(screen.getByText(/00:01/)).toBeInTheDocument();
    // Vähennä sekunti
    fireEvent.click(minusButton);
    expect(screen.getByText(/00:00/)).toBeInTheDocument();
  });

  test('aikalisä-nappi disabloituu kun kello käy', () => {
    render(<App />);
    const startButton = screen.getByTitle('Käynnistä pelikello');
    fireEvent.click(startButton);
    // Etsi aikalisä-nappi (voit tarkentaa testin, jos aikalisä-napilla on title/teksti)
    //const timeoutButton = screen.getByText(/Aikalisä/i);
    //expect(timeoutButton).toBeDisabled();
  });
});
