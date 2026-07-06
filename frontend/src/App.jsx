import { useState } from "react";
import "./App.css";
import Login from "./components/Login";

function App() {
  const [user, setUser] = useState(null);
  const [authPage, setAuthPage] = useState("login");

  const handleLogin = (userData) => {
    if (authPage === "register") {
      setAuthPage("login");
    } else {
      setUser(userData);
    }
  };

  const handleNavigate = (page) => {
    setAuthPage(page);
  };

  return (
    <div className="app">
      <Login
        onLogin={handleLogin}
        onNavigate={handleNavigate}
        authPage={authPage}
      />
    </div>
  );
}

export default App;
