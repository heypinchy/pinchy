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

export function GoogleIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" className={className}>
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
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
