import axios from "axios";

const api = axios.create({
  baseURL: "http://localhost:5000/api", // change if backend runs elsewhere
  withCredentials: true,
});

export default api;
