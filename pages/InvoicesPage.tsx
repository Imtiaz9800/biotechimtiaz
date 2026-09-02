
import React, { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { supabase } from '../hooks/lib/supabase';
import { InvoiceWithDetails, InvoiceItem, Invoice, Customer, Unit, CompanyDetails } from '../types';
import { Button } from '../components/ui/Button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/Card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/Table';
import { PlusCircle, Pencil, Trash2, Download, Search, Eye } from 'lucide-react';
import { formatDate, formatCurrency, formatNumber } from '../hooks/lib/utils';
import Pagination from '../components/ui/Pagination';
import Dialog from '../components/ui/Dialog';
import InvoiceTemplate from '../components/InvoiceTemplate';
import { toast } from '../components/ui/Toaster';
import { Input } from '../components/ui/Input';
import { useDebounce } from '../hooks/useDebounce';
import Skeleton from '../components/ui/Skeleton';
import { useNavigate } from 'react-router-dom';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';

const ITEMS_PER_PAGE = 10;

type FullInvoice = Invoice & {
    customers: Pick<Customer, 'name' | 'billing_address' | 'gst_pan' | 'phone'> | null;
    invoice_items: (InvoiceItem & { products: { name: string; hsn_code: string | null; units?: Pick<Unit, 'abbreviation'> | null } | null })[];
};

// Fetch Functions
const fetchInvoices = async (page: number, searchTerm: string): Promise<{ data: InvoiceWithDetails[], count: number }> => {
  const from = (page - 1) * ITEMS_PER_PAGE;
  const to = from + ITEMS_PER_PAGE - 1;

  let query = supabase
    .from('invoices')
    .select('*, customers(name)', { count: 'exact' });
  
  if (searchTerm) {
    query = query.or(`invoice_number.ilike.%${searchTerm}%,customers.name.ilike.%${searchTerm}%`);
  }
    
  const { data, error, count } = await query
    .order('created_at', { ascending: false })
    .range(from, to);
    
  if (error) throw new Error(error.message);
  return { data: data as InvoiceWithDetails[], count: count || 0 };
};

const fetchInvoiceWithItems = async (invoiceId: string): Promise<FullInvoice> => {
  const { data, error } = await supabase
    .from('invoices')
    .select(`
        id, created_at, customer_id, invoice_number, invoice_date, notes, total_amount,
        customers(*),
        invoice_items(*, products(name, hsn_code, units(abbreviation)))
    `)
    .eq('id', invoiceId)
    .single();

  if (error) {
    console.error('Error fetching single invoice:', error);
    throw new Error(`Could not fetch invoice details: ${error.message}`);
  }
  return data as FullInvoice;
};

const fetchCompanyDetails = async (): Promise<CompanyDetails | null> => {
    const { data, error } = await supabase
        .from('company_details')
        .select('*')
        .eq('id', 1)
        .single();
    if (error && error.code !== 'PGRST116') throw error;
    return data;
};

const deleteInvoice = async (invoiceId: string) => {
  const { error } = await supabase.rpc('delete_invoice_by_id', {
    p_invoice_id: invoiceId
  });
    
  if (error) {
    throw new Error(error.message);
  }
};

const WhatsAppIcon = (props: React.SVGProps<SVGSVGElement>) => (
    <svg role="img" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" {...props} fill="currentColor">
        <path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91C2.13 13.66 2.61 15.35 3.49 16.81L2 22L7.33 20.55C8.75 21.37 10.36 21.82 12.04 21.82H12.05C17.5 21.82 21.95 17.37 21.96 11.91C21.96 9.22 20.91 6.74 19.09 4.92C17.27 3.1 14.79 2 12.04 2M12.05 3.67C14.25 3.67 16.31 4.53 17.87 6.09C19.42 7.65 20.28 9.71 20.28 11.91C20.27 16.45 16.59 20.13 12.05 20.13H12.04C10.56 20.13 9.13 19.72 7.89 18.96L7.54 18.76L4.32 19.68L5.26 16.54L5.05 16.19C4.22 14.88 3.81 13.41 3.81 11.91C3.81 7.37 7.5 3.67 12.05 3.67M9.01 7.29C8.83 7.29 8.6 7.34 8.41 7.72C8.23 8.1 7.68 8.65 7.68 9.7C7.68 10.75 8.43 11.72 8.58 11.89C8.74 12.06 10.19 14.39 12.47 15.33C14.33 16.11 14.74 15.93 15.08 15.9C15.54 15.86 16.48 15.31 16.66 14.76C16.84 14.21 16.84 13.78 16.78 13.67C16.72 13.56 16.54 13.48 16.29 13.36C16.05 13.24 14.93 12.69 14.71 12.61C14.49 12.53 14.33 12.48 14.17 12.73C14.01 12.98 13.46 13.62 13.32 13.78C13.18 13.94 13.04 13.96 12.79 13.84C12.55 13.72 11.66 13.41 10.59 12.45C9.77 11.7 9.23 10.79 9.07 10.54C8.91 10.29 9.04 10.15 9.16 10.03C9.27 9.91 9.42 9.73 9.56 9.57C9.7 9.41 9.75 9.31 9.85 9.11C9.95 8.91 9.9 8.75 9.83 8.64C9.75 8.52 9.26 7.4 9.06 7.29" />
    </svg>
);

const InvoicesPage: React.FC = () => {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [selectedInvoice, setSelectedInvoice] = useState<FullInvoice | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [searchTerm, setSearchTerm] = useState('');
  const [canShare, setCanShare] = useState(false);
  const debouncedSearchTerm = useDebounce(searchTerm, 300);

  const { data: invoicesData, isLoading, error } = useQuery({
    queryKey: ['invoices', currentPage, debouncedSearchTerm],
    queryFn: () => fetchInvoices(currentPage, debouncedSearchTerm),
    placeholderData: keepPreviousData,
  });
  
  const { data: companyDetails } = useQuery({
    queryKey: ['companyDetails'],
    queryFn: fetchCompanyDetails,
  });

  useEffect(() => {
    setCurrentPage(1);
  }, [debouncedSearchTerm]);

  useEffect(() => {
    if (navigator.share) {
        setCanShare(true);
    }
  }, []);

  const invoices = invoicesData?.data ?? [];
  const totalCount = invoicesData?.count ?? 0;
  const totalPages = Math.ceil(totalCount / ITEMS_PER_PAGE);

  const deleteMutation = useMutation({
    mutationFn: deleteInvoice,
    onSuccess: () => {
      toast('Invoice deleted and stock adjusted successfully!');
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
      queryClient.invalidateQueries({ queryKey: ['stock'] });
      queryClient.invalidateQueries({ queryKey: ['dashboardStats'] });
      queryClient.invalidateQueries({ queryKey: ['products'] });
      queryClient.invalidateQueries({ queryKey: ['reports'] });
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : 'An unknown error occurred.';
      toast(`Error deleting invoice: ${message}`);
    },
  });

  const handleViewClick = async (invoiceId: string) => {
    try {
        const fullInvoice = await fetchInvoiceWithItems(invoiceId);
        setSelectedInvoice(fullInvoice);
        setIsModalOpen(true);
    } catch (err) {
        toast(`Error fetching invoice details: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  };

  const generateInvoicePDF = (invoice: FullInvoice, companyDetails: CompanyDetails | null) => {
    const doc = new jsPDF({
        orientation: 'portrait',
        unit: 'mm',
        format: 'a4'
    });
    
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    
    // Fonts & Colors
    doc.setFont("helvetica");
    const grayColor = "#6b7280";
    const blackColor = "#111827";
    const borderColor = [200, 200, 200]; // Darker gray for visible boxing

    // --- Header ---
    doc.setTextColor(blackColor);
    doc.setFontSize(20);
    doc.setFont("helvetica", "bold");
    doc.text(String(companyDetails?.name || "Company Name").toUpperCase(), 14, 20);
    
    doc.setFontSize(10);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(grayColor);
    if (companyDetails?.slogan) {
        doc.text(String(companyDetails.slogan), 14, 26);
    }

    doc.setTextColor(grayColor);
    doc.setFontSize(16);
    doc.text("Invoice", pageWidth - 14, 20, { align: "right" });
    
    doc.setFontSize(10);
    doc.setTextColor(blackColor);
    doc.text(`No: ${invoice.invoice_number}`, pageWidth - 14, 28, { align: "right" });
    try {
        doc.text(`Date: ${formatDate(invoice.invoice_date)}`, pageWidth - 14, 33, { align: "right" });
    } catch (e) {
        doc.text(`Date: ${invoice.invoice_date}`, pageWidth - 14, 33, { align: "right" });
    }

    // --- Billing Boxes ---
    const boxY = 45;
    const boxHeight = 45; 
    const boxWidth = (pageWidth - 28 - 10) / 2; 
    const box2X = 14 + boxWidth + 10;

    const drawBox = (x: number, y: number, title: string, content: string[]) => {
        // Draw the main border box
        doc.setDrawColor(borderColor[0], borderColor[1], borderColor[2]);
        doc.setLineWidth(0.2); // Thicker line for "boxing"
        doc.roundedRect(x, y, boxWidth, boxHeight, 2, 2, 'S');
        
        // Title
        doc.setFontSize(10);
        doc.setTextColor(grayColor);
        doc.text(title, x + 4, y + 8);
        
        // Separator line
        doc.line(x, y + 12, x + boxWidth, y + 12);
        
        // Content
        let currentY = y + 18;
        content.forEach(line => {
            if (line) {
                const lineStr = String(line);
                const parts = lineStr.split(':');
                if (parts.length > 1) {
                    doc.setFont("helvetica", "bold");
                    doc.setFontSize(9);
                    doc.setTextColor(blackColor);
                    doc.text(parts[0] + ":", x + 4, currentY);
                    const labelWidth = doc.getTextWidth(parts[0] + ":");
                    
                    const valueText = parts.slice(1).join(':').trim();
                    // MIRROR CUSTOMER NAME STYLING
                    if (parts[0].toLowerCase().includes('customer')) {
                        doc.setFontSize(10.5);
                        doc.setFont("helvetica", "bold");
                    } else {
                        doc.setFontSize(9);
                        doc.setFont("helvetica", "normal");
                    }
                    doc.text(valueText, x + 4 + labelWidth + 2, currentY);
                } else {
                    doc.setFontSize(9);
                    doc.setFont("helvetica", "normal");
                    doc.setTextColor(blackColor);
                    doc.text(lineStr, x + 4, currentY);
                }
                currentY += 6;
            }
        });
    };

    const billedByLines = [
        `Name: ${companyDetails?.name || ''}`,
        `Address: ${companyDetails?.address || ''}`.substring(0, 45) + (companyDetails?.address && companyDetails.address.length > 45 ? '...' : ''),
        `GSTIN: ${companyDetails?.gstin || ''}`
    ];
    
    const billedToLines = [
        `Customer: ${invoice.customers?.name || 'Guest'}`,
        `Phone: ${invoice.customers?.phone || 'N/A'}`,
        `Address: ${invoice.customers?.billing_address || 'N/A'}`.substring(0, 45) + (invoice.customers?.billing_address && invoice.customers.billing_address.length > 45 ? '...' : ''),
        `GSTIN / PAN: ${invoice.customers?.gst_pan || 'N/A'}`
    ];

    drawBox(14, boxY, "Billed By", billedByLines);
    drawBox(box2X, boxY, "Billed To", billedToLines);

    // --- Items Table ---
    const tableBody = invoice.invoice_items.map((item) => {
        const taxableValue = item.quantity * item.unit_price;
        const taxAmount = taxableValue * item.tax_rate;
        const totalValue = taxableValue + taxAmount;
        
        return [
            String(item.products?.name || "Item"),
            String(item.products?.hsn_code || "-"),
            String(item.quantity),
            String(item.products?.units?.abbreviation || ""),
            formatNumber(item.unit_price * (1 + item.tax_rate)), // Inclusive Rate
            formatNumber(taxableValue),
            `${(item.tax_rate * 100).toFixed(0)}%`,
            formatNumber(taxAmount / 2), 
            formatNumber(taxAmount / 2), 
            formatNumber(totalValue)
        ];
    });

    const totalTaxable = invoice.invoice_items.reduce((sum, item) => sum + (item.quantity * item.unit_price), 0);
    const totalTax = invoice.invoice_items.reduce((sum, item) => sum + (item.quantity * item.unit_price * item.tax_rate), 0);
    const grandTotal = totalTaxable + totalTax;

    const formatCurrencyPDF = (amount: number) => `Rs. ${formatNumber(amount)}`;

    autoTable(doc, {
        startY: boxY + boxHeight + 10,
        head: [["Item", "HSN/SAC", "Qty", "Unit", "Rate", "Taxable", "GST %", "CGST", "SGST", "Total"]],
        body: tableBody,
        theme: 'grid',
        headStyles: { 
            fillColor: [245, 245, 245], 
            textColor: [0, 0, 0], 
            fontSize: 8, 
            fontStyle: 'bold',
            lineWidth: 0.2, // Increased grid line width
            lineColor: borderColor
        },
        bodyStyles: { 
            fontSize: 8, 
            textColor: blackColor,
            lineWidth: 0.2, // Increased grid line width
            lineColor: borderColor
        },
        columnStyles: {
            0: { cellWidth: 'auto' },
            1: { halign: 'center' },
            2: { halign: 'center' },
            3: { halign: 'center' },
            4: { halign: 'right' },
            5: { halign: 'right' },
            6: { halign: 'center' },
            7: { halign: 'right' },
            8: { halign: 'right' },
            9: { halign: 'right', fontStyle: 'bold' },
        },
    });

    let finalY = (doc as any).lastAutoTable ? (doc as any).lastAutoTable.finalY + 5 : boxY + boxHeight + 20;

    // --- Totals Box ---
    if (finalY > pageHeight - 50) {
        doc.addPage();
        finalY = 20;
    }

    const totalsWidth = 80;
    const totalsX = pageWidth - 14 - totalsWidth;
    const totalsY = finalY;
    const totalsLineHeight = 6;
    const totalsHeight = (totalsLineHeight * 4) + 4; 

    doc.setDrawColor(borderColor[0], borderColor[1], borderColor[2]); 
    doc.setLineWidth(0.2); // Visible boxing
    doc.rect(totalsX, totalsY, totalsWidth, totalsHeight);

    doc.setFontSize(9);
    doc.setTextColor(blackColor);
    
    let currentTotalY = totalsY + 6;
    const rightAlignX = pageWidth - 18; 
    const leftAlignX = totalsX + 4;

    doc.setFont("helvetica", "normal");
    doc.text("Taxable Value:", leftAlignX, currentTotalY);
    doc.text(formatCurrencyPDF(totalTaxable), rightAlignX, currentTotalY, { align: "right" });
    
    currentTotalY += totalsLineHeight;
    doc.text("CGST:", leftAlignX, currentTotalY);
    doc.text(formatCurrencyPDF(totalTax / 2), rightAlignX, currentTotalY, { align: "right" });

    currentTotalY += totalsLineHeight;
    doc.text("SGST:", leftAlignX, currentTotalY);
    doc.text(formatCurrencyPDF(totalTax / 2), rightAlignX, currentTotalY, { align: "right" });

    currentTotalY += 2;
    doc.line(totalsX, currentTotalY - 2 + (totalsLineHeight/2), pageWidth - 14, currentTotalY - 2 + (totalsLineHeight/2)); 
    
    currentTotalY += 4;
    doc.setFont("helvetica", "bold");
    doc.text("Total (INR):", leftAlignX, currentTotalY);
    doc.text(formatCurrencyPDF(grandTotal), rightAlignX, currentTotalY, { align: "right" });

    finalY = totalsY + totalsHeight + 10;

    if (finalY > pageHeight - 60) {
        doc.addPage();
        finalY = 20;
    }

    const footerY = finalY;
    doc.setFontSize(9);
    doc.setFont("helvetica", "bold");
    doc.text("Bank Details", 14, footerY);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    
    let bankY = footerY + 6;
    if (companyDetails?.bank_name) { doc.text(`Bank: ${companyDetails.bank_name}`, 14, bankY); bankY += 5; }
    if (companyDetails?.account_number) { doc.text(`A/c No: ${companyDetails.account_number}`, 14, bankY); bankY += 5; }
    if (companyDetails?.ifsc_code) { doc.text(`IFSC: ${companyDetails.ifsc_code}`, 14, bankY); bankY += 5; }
    
    // Add "Computer Generated Invoice" text instead of Authorised Signatory
    doc.setFont("helvetica", "italic");
    doc.setFontSize(8);
    doc.setTextColor(grayColor);
    doc.text("This is a computer generated invoice", pageWidth - 14, footerY + 25, { align: "right" });

    if (invoice.notes) {
        const notesY = footerY + 35;
        doc.setFontSize(8);
        doc.setTextColor(grayColor);
        doc.text(`Notes: ${invoice.notes}`, 14, notesY);
    }

    return doc;
  };
  
  const handleDownloadPDF = () => {
    if (!selectedInvoice) {
      toast('Cannot download PDF: Missing invoice.');
      return;
    }
    toast('Generating PDF...');
    try {
      const doc = generateInvoicePDF(selectedInvoice, companyDetails || null);
      doc.save(`Invoice-${selectedInvoice.invoice_number}.pdf`);
    } catch (error) {
      console.error('Error generating PDF:', error);
      toast(`Failed to generate PDF: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  };
  
  const handleShareWhatsApp = async () => {
    if (!selectedInvoice) {
        toast('Cannot share: Missing invoice.');
        return;
    }
    toast('Preparing to share...');
    try {
        const doc = generateInvoicePDF(selectedInvoice, companyDetails || null);
        const pdfBlob = doc.output('blob');
        const fileName = `Invoice-${selectedInvoice.invoice_number}.pdf`;
        const pdfFile = new File([pdfBlob], fileName, { type: 'application/pdf' });
        
        const shareData = {
            files: [pdfFile],
            title: `Invoice ${selectedInvoice.invoice_number}`,
            text: `Here is invoice ${selectedInvoice.invoice_number}.`,
        };

        if (navigator.canShare && navigator.canShare(shareData)) {
            await navigator.share(shareData);
        } else {
            toast('Sharing not supported on this browser or for this file type.');
        }
    } catch (error) {
        if ((error as Error).name !== 'AbortError') {
             toast(`Sharing failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }
  };

  const handleDeleteClick = (invoiceId: string) => {
    if (window.confirm('Are you sure you want to delete this invoice? This action will restore product stock and cannot be undone.')) {
      deleteMutation.mutate(invoiceId);
    }
  };

  const renderSkeleton = () => (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Invoice #</TableHead>
            <TableHead>Customer</TableHead>
            <TableHead>Date</TableHead>
            <TableHead>Amount</TableHead>
            <TableHead className="text-center">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {Array.from({ length: ITEMS_PER_PAGE }).map((_, index) => (
            <TableRow key={index}>
              <TableCell><Skeleton className="h-5 w-3/4" /></TableCell>
              <TableCell><Skeleton className="h-5 w-1/2" /></TableCell>
              <TableCell><Skeleton className="h-5 w-1/3" /></TableCell>
              <TableCell><Skeleton className="h-5 w-1/4" /></TableCell>
              <TableCell>
                <div className="flex items-center justify-center space-x-2">
                  <Skeleton className="h-8 w-8 rounded-md" />
                  <Skeleton className="h-8 w-8 rounded-md" />
                  <Skeleton className="h-8 w-8 rounded-md" />
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold bg-gradient-to-r from-blue-600 via-indigo-500 to-purple-600 bg-clip-text text-transparent">Invoices</h1>
        <Button onClick={() => navigate('/invoices/new')}>
          <PlusCircle className="w-4 h-4 mr-2" />
          New Invoice
        </Button>
      </div>

      <Card>
        <CardHeader>
          <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
            <CardTitle>Invoice List</CardTitle>
            <div className="relative w-full sm:w-64">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-gray-400" />
              <Input
                placeholder="Search by # or Customer..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="pl-10"
              />
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? renderSkeleton() : error instanceof Error ? <p className="text-red-500">Error: {error.message}</p> : (
            <>
              <div className="overflow-x-auto">
                <Table className="responsive-table">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Invoice #</TableHead>
                      <TableHead>Customer</TableHead>
                      <TableHead>Date</TableHead>
                      <TableHead>Amount</TableHead>
                      <TableHead className="text-center">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {invoices.length > 0 ? invoices.map((invoice) => (
                      <TableRow key={invoice.id}>
                        <TableCell data-label="Invoice #" className="font-medium">{invoice.invoice_number}</TableCell>
                        <TableCell data-label="Customer">{invoice.customers?.name || 'Guest'}</TableCell>
                        <TableCell data-label="Date">{formatDate(invoice.invoice_date)}</TableCell>
                        <TableCell data-label="Amount">{formatCurrency(invoice.total_amount)}</TableCell>
                        <TableCell data-label="Actions">
                          <div className="flex items-center justify-center space-x-2 md:justify-center">
                             <Button variant="ghost" size="icon" onClick={() => handleViewClick(invoice.id)} aria-label="View Invoice">
                              <Eye className="w-4 h-4" />
                            </Button>
                            <Button variant="ghost" size="icon" onClick={() => navigate(`/invoices/edit/${invoice.id}`)} aria-label="Edit Invoice">
                              <Pencil className="w-4 h-4" />
                            </Button>
                            <Button variant="destructive-outline" size="icon" onClick={() => handleDeleteClick(invoice.id)} disabled={deleteMutation.isPending} aria-label="Delete Invoice">
                              <Trash2 className="w-4 h-4" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    )) : (
                      <TableRow>
                        <TableCell colSpan={6} className="text-center h-24">No invoices found.</TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>
              <Pagination
                currentPage={currentPage}
                totalPages={totalPages}
                onPageChange={setCurrentPage}
                totalCount={totalCount}
                itemsPerPage={ITEMS_PER_PAGE}
              />
            </>
          )}
        </CardContent>
      </Card>

      <Dialog isOpen={isModalOpen} onClose={() => setIsModalOpen(false)} title={`Invoice Preview: ${selectedInvoice?.invoice_number}`} size="lg">
         {selectedInvoice && (
          <div>
            <div className="flex justify-end gap-2 mb-4 no-print">
               <Button onClick={handleDownloadPDF}>
                  <Download className="w-4 h-4 mr-2" />
                  Download
               </Button>
               {canShare && (
                <Button variant="secondary" onClick={handleShareWhatsApp}>
                    <WhatsAppIcon className="w-5 h-5 mr-2" />
                    Share via WhatsApp
                </Button>
               )}
            </div>
            <div>
               <InvoiceTemplate invoice={selectedInvoice} companyDetails={companyDetails || null} />
            </div>
          </div>
         )}
      </Dialog>
    </div>
  );
};

export default InvoicesPage;
