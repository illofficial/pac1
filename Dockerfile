FROM nginx:alpine
COPY nginx.conf /etc/nginx/nginx.conf
COPY index.html mastering_chain.js /usr/share/nginx/html/
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]