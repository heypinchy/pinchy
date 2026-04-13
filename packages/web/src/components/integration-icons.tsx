export function OdooIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 191" className={className}>
      <mask id="odoo-holes">
        <rect width="600" height="191" fill="white" />
        <circle cx="527.5" cy="118.4" r="42.7" fill="black" />
        <circle cx="374" cy="118.4" r="42.7" fill="black" />
        <circle cx="222.5" cy="118.4" r="42.7" fill="black" />
        <circle cx="71.7" cy="118.5" r="42.7" fill="black" />
      </mask>
      <g mask="url(#odoo-holes)" fill="currentColor">
        <circle cx="527.5" cy="118.4" r="72.4" />
        <circle cx="374" cy="118.4" r="72.4" />
        <path d="M294.9 117.8v.6c0 40-32.4 72.4-72.4 72.4s-72.4-32.4-72.4-72.4S182.5 46 222.5 46c16.4 0 31.5 5.5 43.7 14.6V14.4A14.34 14.34 0 0 1 280.6 0c7.9 0 14.4 6.5 14.4 14.4v102.7c0 .2 0 .5-.1.7z" />
        <circle cx="72.4" cy="118.2" r="72.4" />
      </g>
    </svg>
  );
}

export function PipedriveIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 32 32"
      className={className}
      fill="currentColor"
    >
      <path d="M17.4 2C13 2 10 5.1 10 9.7v12.6c0 .5.1 1 .4 1.3.3.4.7.5 1.2.5.4 0 .9-.2 1.2-.5.3-.4.4-.8.4-1.3v-4.6c1.2.9 2.7 1.4 4.2 1.4 4.4 0 7.6-3.3 7.6-8 0-4.8-3.1-9.1-7.6-9.1zm-.2 14.1c-2.5 0-4.2-2.1-4.2-5s1.7-5.1 4.2-5.1 4.1 2.2 4.1 5.1-1.6 5-4.1 5z" />
    </svg>
  );
}
