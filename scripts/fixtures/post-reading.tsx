import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AppProvider } from '../../src/store';
import { PostDetail, PostsPage } from '../../src/pages/Posts';
import '../../src/index.css';
function Harness() {
  const [id, setId] = useState(1);
  const [active, setActive] = useState(false);
  Object.assign(window, { postReading: { setId, setActive } });
  return <div className="plat-ios" style={{ position: 'absolute', inset: 0 }}>
    {location.search.includes('list') ? <PostsPage onBack={() => {}} wide={innerWidth > 640} /> : <PostDetail id={id} onBack={() => {}} active={active} />}
  </div>;
}
createRoot(document.getElementById('root')!).render(<AppProvider><Harness /></AppProvider>);
