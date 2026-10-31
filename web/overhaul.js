// Cinematic overhaul for Screens 2-4 (Owner: Harry; overhaul agent). Kill switch: add ?classic to the URL.
if (!new URLSearchParams(location.search).has("classic")) document.documentElement.classList.add("overhaul");
