output "admin_vm_public_ip" {
  value = azurerm_public_ip.pip[*].ip_address
}

output "static_web_app_api_key" {
  value     = azurerm_static_web_app.frontend.api_key
  sensitive = true
}
