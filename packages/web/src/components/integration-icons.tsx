export function BraveIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      className={className}
      fill="currentColor"
    >
      <path d="M12 2L4 6v6c0 5.55 3.84 10.74 8 12 4.16-1.26 8-6.45 8-12V6l-8-4zm0 2.18l6 3v5.82c0 4.53-3.13 8.76-6 9.88-2.87-1.12-6-5.35-6-9.88V7.18l6-3zM11 7v6h2V7h-2zm0 8v2h2v-2h-2z" />
    </svg>
  );
}

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
