# Cabeceras que necesita la aplicación detrás del proxy.
#
# Sin X-Forwarded-For, la bitácora de auditoría registraría la dirección
# interna de Nginx en todos los accesos, y dejaría de servir para saber
# desde dónde se consultó una historia clínica.

proxy_set_header Host              $host;
proxy_set_header X-Real-IP         $remote_addr;
proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;

proxy_connect_timeout 10s;
proxy_send_timeout    60s;
proxy_read_timeout    60s;
