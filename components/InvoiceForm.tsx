import React, { useEffect, useMemo, useState, useRef } from 'react';
import { useForm, useFieldArray, SubmitHandler, useWatch } from 'react-hook-form';
import { useMutation, useQueryClient, useQuery } from '@tanstack/react-query';
import { supabase } from '../hooks/lib/supabase';
import { Invoice, InvoiceItem, Customer, Product, CustomerInsert, Unit } from '../types';
import { Input } from './ui/Input';
import { Button } from './ui/Button';
import { toast } from './ui/Toaster';
import { Trash2, Search, PlusCircle, AlertCircle } from 'lucide-react';
import { formatCurrency } from '../hooks/lib/utils';

type FullInvoice = Invoice & {
    customers: Pick<Customer, 'name' | 'billing_address' | 'gst_pan' | 'phone' | 'is_guest'> | null;
    invoice_items: (InvoiceItem & { products: { name: string; hsn_code: string | null; units?: Pick<Unit, 'abbreviation'> | null; } | null })[];
};

interface InvoiceFormProps {
  invoice?: FullInvoice;
  onSuccess: () => void;
  onCancel: () => void;
}

type FormValues = {
  customer_mode: 'existing' | 'new' | 'guest';
  customer_id: string | null;
  customer_name_display: string;
  invoice_date: string;
  invoice_number: string;
  notes: string;
  items: {
    product_id: string;
    product_name_display: string;
    quantity: number;
    unit_price: number; // pre-tax, calculated
    tax_rate: number;
    inclusive_rate: number; // GST-inclusive, this is what the user types in the "Rate" field
    unit_display: string; // For display
    hsn_code: string; // For display
    original_quantity: number; // To track stock ownership for validation
  }[];
  new_customer_name?: string;
  new_customer_phone?: string;
  new_customer_gst_pan?: string;
  new_customer_billing_address?: string;
};

// Fetch functions
const fetchCustomers = async (): Promise<Pick<Customer, 'id' | 'name'>[]> => {
  const { data, error } = await supabase.from('customers').select('id, name').neq('name', '__SYSTEM_PING__').order('name');
  if (error) throw new Error(error.message);
  return data || [];
};

const fetchProducts = async (): Promise<Product[]> => {
  const { data, error } = await supabase.from('products').select('*, units(abbreviation)').order('name');
  if (error) throw new Error(error.message);
  return data || [];
};

const fetchLastInvoiceNumber = async (): Promise<string | null> => {
  const savedSettings = localStorage.getItem('invoiceSettings');
  let prefix = 'INV-';
  let suffix = '';
  let padding = 3;
  if (savedSettings) {
      try {
          const parsed = JSON.parse(savedSettings);
          prefix = parsed.prefix ?? 'INV-';
          suffix = parsed.suffix ?? '';
          padding = parsed.padding ?? 3;
      } catch (e) {
          // fallback
      }
  }

  const { data, error } = await supabase
    .from('invoices')
    .select('invoice_number')
    .order('created_at', { ascending: false })
    .limit(1000);
  
  if (error) throw error;
  
  const existingNumbers = new Set((data || []).map(d => d.invoice_number));
  
  let maxNum = 0;

  (data || []).forEach(row => {
    if (row.invoice_number && row.invoice_number.startsWith(prefix) && row.invoice_number.endsWith(suffix)) {
        // Extract the middle part
        const middle = row.invoice_number.substring(prefix.length, row.invoice_number.length - suffix.length);
        const parsed = parseInt(middle, 10);
        if (!isNaN(parsed) && parsed > maxNum) {
            maxNum = parsed;
        }
    }
  });

  let num = maxNum + 1;
  let nextInvoiceNum = `${prefix}${num.toString().padStart(padding, '0')}${suffix}`;
  
  while (existingNumbers.has(nextInvoiceNum)) {
    num++;
    nextInvoiceNum = `${prefix}${num.toString().padStart(padding, '0')}${suffix}`;
  }
  
  return nextInvoiceNum;
};

const upsertInvoice = async ({ formData, id }: { formData: FormValues, id?: string }) => {
    let customerId = formData.customer_id;

    if (formData.customer_mode === 'guest') {
        customerId = null;
    } else if (formData.customer_mode === 'new') {
        if (!formData.new_customer_name) throw new Error("Customer name is required for new customers.");
        
        const newCustomer: CustomerInsert = {
            name: formData.new_customer_name,
            email: null,
            phone: formData.new_customer_phone || null,
            gst_pan: formData.new_customer_gst_pan || null,
            billing_address: formData.new_customer_billing_address || null,
            is_guest: false
        };
        const { data: createdCustomer, error: createError } = await supabase.from('customers').insert(newCustomer).select('id').single();
        if (createError) throw createError;
        customerId = createdCustomer.id;
    } else {
        // Existing mode
        if (!customerId) throw new Error("Please select an existing customer.");
    }

    const invoiceData = {
        customer_id: customerId,
        invoice_date: formData.invoice_date,
        invoice_number: formData.invoice_number,
        notes: formData.notes,
        total_amount: 0, // Will be recalculated by trigger or below
    };

    // Calculate total for the invoice record
    let calculatedTotal = 0;
    formData.items.forEach(item => {
         // item.inclusive_rate is what user sees.
         calculatedTotal += (item.quantity * item.inclusive_rate);
    });
    invoiceData.total_amount = calculatedTotal;

    let invoiceId = id;

    if (id) {
        const { error } = await supabase.from('invoices').update(invoiceData).eq('id', id);
        if (error) throw error;
        
        // Delete existing items to replace them (simpler than syncing)
        const { error: deleteError } = await supabase.from('invoice_items').delete().eq('invoice_id', id);
        if (deleteError) throw deleteError;
    } else {
        const { data: newInvoice, error } = await supabase.from('invoices').insert(invoiceData).select('id').single();
        if (error) throw error;
        invoiceId = newInvoice.id;
    }

    if (!invoiceId) throw new Error("Failed to get invoice ID");

    const itemsToInsert = formData.items.map(item => ({
        invoice_id: invoiceId!,
        product_id: item.product_id,
        quantity: item.quantity,
        unit_price: item.inclusive_rate / (1 + item.tax_rate), // Calculate pre-tax price
        tax_rate: item.tax_rate
    }));

    if (itemsToInsert.length > 0) {
        const { error: itemsError } = await supabase.from('invoice_items').insert(itemsToInsert);
        if (itemsError) throw itemsError;
    }
};

const InvoiceForm: React.FC<InvoiceFormProps> = ({ invoice, onSuccess, onCancel }) => {
  const queryClient = useQueryClient();
  const [customerSuggestionsOpen, setCustomerSuggestionsOpen] = useState(false);
  const [productSuggestionsOpen, setProductSuggestionsOpen] = useState<{index: number, isOpen: boolean}>({index: -1, isOpen: false});
  
  // Refs for clicking outside
  const customerWrapperRef = useRef<HTMLDivElement>(null);

  const { data: customers } = useQuery({ queryKey: ['customersList'], queryFn: fetchCustomers });
  const { data: products } = useQuery({ queryKey: ['productsList'], queryFn: fetchProducts });

  const { register, control, handleSubmit, watch, setValue, reset, formState: { errors, isSubmitting } } = useForm<FormValues>({
    defaultValues: {
      customer_mode: 'existing',
      customer_id: null,
      customer_name_display: '',
      invoice_date: new Date().toISOString().split('T')[0],
      invoice_number: '',
      notes: '',
      items: [],
      new_customer_name: '',
      new_customer_phone: '',
      new_customer_gst_pan: '',
      new_customer_billing_address: ''
    }
  });

  const { fields, append, remove, update } = useFieldArray({
    control,
    name: "items"
  });

  // Watch for real-time calculations and UI state
  const watchedItems = useWatch({ control, name: "items", defaultValue: [] });
  const customerNameDisplay = watch("customer_name_display");
  const customerMode = watch("customer_mode");

  // Initialize form
  useEffect(() => {
    const init = async () => {
        if (invoice) {
            const formattedItems = invoice.invoice_items.map(item => ({
                product_id: item.product_id,
                product_name_display: item.products?.name || '',
                quantity: item.quantity,
                unit_price: item.unit_price,
                tax_rate: item.tax_rate,
                inclusive_rate: item.unit_price * (1 + item.tax_rate),
                unit_display: item.products?.units?.abbreviation || '',
                hsn_code: item.products?.hsn_code || '',
                original_quantity: item.quantity
            }));
            
            let mode: 'existing' | 'new' | 'guest' = 'existing';
            if (!invoice.customer_id) {
                mode = 'guest';
            }

            reset({
                customer_mode: mode,
                customer_id: invoice.customer_id,
                customer_name_display: invoice.customers?.name || '',
                invoice_date: invoice.invoice_date,
                invoice_number: invoice.invoice_number,
                notes: invoice.notes || '',
                items: formattedItems
            });
        } else {
            const nextInvoiceNum = await fetchLastInvoiceNumber() || 'INV-001';
            
            reset({
                customer_mode: 'existing',
                customer_id: null,
                customer_name_display: '',
                invoice_date: new Date().toISOString().split('T')[0],
                invoice_number: nextInvoiceNum,
                notes: '',
                items: []
            });
        }
    };
    init();
  }, [invoice, reset]);

  // Close dropdowns on outside click
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (customerWrapperRef.current && !customerWrapperRef.current.contains(event.target as Node)) {
        setCustomerSuggestionsOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, []);


  const filteredCustomers = useMemo(() => {
      if (!customers || !customerNameDisplay) return customers || [];
      return customers.filter(c => c.name.toLowerCase().includes(customerNameDisplay.toLowerCase()));
  }, [customers, customerNameDisplay]);

  const mutation = useMutation({
    mutationFn: upsertInvoice,
    onSuccess: () => {
      toast(`Invoice ${invoice ? 'updated' : 'created'} successfully!`);
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
      // Stock updates happen via DB triggers
      queryClient.invalidateQueries({ queryKey: ['stock'] }); 
      onSuccess();
    },
    onError: (error: any, variables: any) => {
      if (error?.message?.includes('invoices_invoice_number_key') || error?.code === '23505') {
        toast(`Invoice number "${variables.formData.invoice_number}" already exists in your history. Please use a unique number.`);
      } else {
        toast(`Error: ${error.message}`);
      }
    },
  });

  const onSubmit: SubmitHandler<FormValues> = (data) => {
      if (data.items.length === 0) {
          toast("Please add at least one item.");
          return;
      }
      mutation.mutate({ formData: data, id: invoice?.id });
  };

  const handleCustomerSelect = (customer: { id: string, name: string }) => {
      setValue('customer_id', customer.id);
      setValue('customer_name_display', customer.name);
      setCustomerSuggestionsOpen(false);
  };

  const handleProductSelect = (index: number, product: Product) => {
      const inclusiveRate = product.unit_price * (1 + product.tax_rate);
      update(index, {
          product_id: product.id,
          product_name_display: product.name,
          quantity: 0, 
          unit_price: product.unit_price,
          tax_rate: product.tax_rate,
          inclusive_rate: parseFloat(inclusiveRate.toFixed(2)),
          unit_display: product.units?.abbreviation || '',
          hsn_code: product.hsn_code || '',
          original_quantity: 0
      });
      setProductSuggestionsOpen({index: -1, isOpen: false});
  };

  // Calculations
  const totals = useMemo(() => {
      let subtotal = 0;
      let cgst = 0;
      let sgst = 0;

      (watchedItems || []).forEach(item => {
          const qty = Number(item.quantity) || 0;
          const inclRate = Number(item.inclusive_rate) || 0;
          const taxRate = Number(item.tax_rate) || 0;

          const unitPrice = inclRate / (1 + taxRate);
          const taxableValue = qty * unitPrice;
          
          const taxAmount = taxableValue * taxRate;
          
          subtotal += taxableValue;
          cgst += taxAmount / 2;
          sgst += taxAmount / 2;
      });

      return {
          subtotal,
          cgst,
          sgst,
          grandTotal: subtotal + cgst + sgst
      };
  }, [watchedItems]);

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
        {/* Header Section */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            <div className="lg:col-span-1">
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Customer</label>
                
                {/* Customer Mode Radio Buttons */}
                <div className="flex space-x-4 mb-3">
                    <label className="inline-flex items-center cursor-pointer">
                        <input 
                            type="radio" 
                            className="form-radio text-blue-600 focus:ring-blue-500" 
                            value="existing" 
                            checked={customerMode === 'existing'} 
                            onChange={() => setValue('customer_mode', 'existing')} 
                        />
                        <span className="ml-2 text-sm text-gray-700 dark:text-gray-300">Existing</span>
                    </label>
                    <label className="inline-flex items-center cursor-pointer">
                        <input 
                            type="radio" 
                            className="form-radio text-blue-600 focus:ring-blue-500" 
                            value="new" 
                            checked={customerMode === 'new'} 
                            onChange={() => setValue('customer_mode', 'new')} 
                        />
                        <span className="ml-2 text-sm text-gray-700 dark:text-gray-300">New</span>
                    </label>
                    <label className="inline-flex items-center cursor-pointer">
                        <input 
                            type="radio" 
                            className="form-radio text-blue-600 focus:ring-blue-500" 
                            value="guest" 
                            checked={customerMode === 'guest'} 
                            onChange={() => setValue('customer_mode', 'guest')} 
                        />
                        <span className="ml-2 text-sm text-gray-700 dark:text-gray-300">Guest</span>
                    </label>
                </div>

                {/* Conditional Customer Inputs */}
                {customerMode === 'existing' && (
                    <div className="relative" ref={customerWrapperRef}>
                        <Input 
                            {...register('customer_name_display')}
                            placeholder="Type to search customer"
                            autoComplete="off"
                            onFocus={() => setCustomerSuggestionsOpen(true)}
                            onChange={(e) => {
                                setValue('customer_name_display', e.target.value);
                                setValue('customer_id', null); // Clear ID on type
                                setCustomerSuggestionsOpen(true);
                            }}
                        />
                        {customerSuggestionsOpen && (
                            <div className="absolute z-20 w-full mt-1 bg-white dark:bg-gray-800 border rounded-md shadow-lg max-h-60 overflow-y-auto">
                                {filteredCustomers.length > 0 ? (
                                    filteredCustomers.map(c => (
                                        <div 
                                            key={c.id} 
                                            className="p-2 hover:bg-gray-100 dark:hover:bg-gray-700 cursor-pointer"
                                            onClick={() => handleCustomerSelect(c)}
                                        >
                                            {c.name}
                                        </div>
                                    ))
                                ) : (
                                    <div className="p-2 text-gray-500 text-sm">No customers found.</div>
                                )}
                            </div>
                        )}
                        <input type="hidden" {...register('customer_id')} />
                        {errors.customer_mode && <p className="text-red-500 text-xs mt-1">Please select a customer.</p>}
                    </div>
                )}

                {customerMode === 'new' && (
                    <div className="space-y-3 bg-gray-50 dark:bg-gray-800/50 p-3 rounded-md border border-gray-100 dark:border-gray-700">
                        <Input placeholder="Full Name *" {...register('new_customer_name')} />
                        <Input placeholder="Phone Number" {...register('new_customer_phone')} />
                        <Input placeholder="GSTIN / PAN" {...register('new_customer_gst_pan')} />
                        <Input placeholder="Billing Address" {...register('new_customer_billing_address')} />
                    </div>
                )}

                {customerMode === 'guest' && (
                    <div className="p-3 bg-gray-50 dark:bg-gray-800/50 rounded-md border border-gray-100 dark:border-gray-700 text-sm text-gray-500 italic">
                        Guest Checkout - No customer details will be saved for future reference.
                    </div>
                )}
            </div>
            
            <div className="md:col-span-1 lg:col-span-2 grid grid-cols-1 sm:grid-cols-2 gap-4 h-fit">
                <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Invoice Number</label>
                    <Input {...register('invoice_number', { required: true })} />
                </div>
                <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Invoice Date</label>
                    <Input type="date" {...register('invoice_date', { required: true })} />
                </div>
            </div>
        </div>

        {/* Items Section */}
        <div className="space-y-4">
            <h3 className="text-lg font-medium text-gray-900 dark:text-white">Items</h3>
            
            <div className="mb-4">
                <table className="min-w-full divide-y divide-slate-200 dark:divide-slate-700 border-b border-slate-200 dark:border-slate-700">
                    <thead className="bg-slate-50 dark:bg-slate-800">
                        <tr>
                            <th className="px-4 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider w-[40%]">Product</th>
                            <th className="px-4 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider w-[15%]">Qty</th>
                            <th className="px-4 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider w-[15%]">Rate <span className="text-[10px] text-slate-400 normal-case">(Incl. GST)</span></th>
                            <th className="px-4 py-3 text-right text-xs font-medium text-slate-500 uppercase tracking-wider w-[12%]">Taxable</th>
                            <th className="px-4 py-3 text-right text-xs font-medium text-slate-500 uppercase tracking-wider w-[12%]">Total</th>
                            <th className="px-4 py-3 w-[6%]"></th>
                        </tr>
                    </thead>
                    <tbody className="bg-white dark:bg-slate-900 divide-y divide-slate-200 dark:divide-slate-700">
                        {fields.map((field, index) => {
                            const itemValues = watchedItems && watchedItems[index] ? watchedItems[index] : field;
                            const qty = Number(itemValues.quantity) || 0;
                            const inclRate = Number(itemValues.inclusive_rate) || 0;
                            const taxRate = Number(itemValues.tax_rate) || 0;
                            const unitPrice = inclRate / (1 + taxRate);
                            const taxable = qty * unitPrice;
                            const total = qty * inclRate;

                            // Calculate available stock for validation
                            const selectedProduct = products?.find(p => p.id === itemValues.product_id);
                            const availableStock = (selectedProduct?.stock_quantity || 0) + (itemValues.original_quantity || 0);

                            return (
                                <tr key={field.id} className="group hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors">
                                    <td className="px-4 py-3 align-top">
                                        <div className="relative">
                                            <Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
                                            <Input 
                                                {...register(`items.${index}.product_name_display` as const, { required: true })}
                                                placeholder="Search Product..."
                                                className="pl-9"
                                                autoComplete="off"
                                                onFocus={() => setProductSuggestionsOpen({index, isOpen: true})}
                                                onChange={(e) => {
                                                    setValue(`items.${index}.product_name_display`, e.target.value);
                                                    setProductSuggestionsOpen({index, isOpen: true});
                                                }}
                                            />
                                            {productSuggestionsOpen.isOpen && productSuggestionsOpen.index === index && (
                                                <div className="absolute z-50 w-full mt-1 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-md shadow-xl max-h-60 overflow-y-auto">
                                                    {products?.filter(p => p.name.toLowerCase().includes(watch(`items.${index}.product_name_display`).toLowerCase())).map(p => (
                                                        <div 
                                                            key={p.id}
                                                            className="p-2.5 hover:bg-slate-100 dark:hover:bg-slate-700 cursor-pointer text-sm flex justify-between items-center"
                                                            onClick={() => handleProductSelect(index, p)}
                                                            onMouseDown={(e) => e.preventDefault()} 
                                                        >
                                                            <span className="font-medium text-slate-900 dark:text-slate-100">{p.name}</span>
                                                            <span className="text-xs text-slate-500 bg-slate-100 dark:bg-slate-800 px-2 py-0.5 rounded-full">Stock: {p.stock_quantity}</span>
                                                        </div>
                                                    ))}
                                                    {products?.filter(p => p.name.toLowerCase().includes(watch(`items.${index}.product_name_display`).toLowerCase())).length === 0 && (
                                                        <div className="p-3 text-xs text-slate-500 text-center">No products found</div>
                                                    )}
                                                </div>
                                            )}
                                        </div>
                                        <div className="mt-1.5 flex items-center text-xs text-slate-500 gap-3 pl-1">
                                            {watch(`items.${index}.hsn_code`) && <span>HSN: {watch(`items.${index}.hsn_code`)}</span>}
                                            {watch(`items.${index}.hsn_code`) && <span className="w-1 h-1 bg-slate-300 rounded-full"></span>}
                                            <span>Tax: {(taxRate * 100).toFixed(0)}%</span>
                                        </div>
                                    </td>
                                    <td className="px-4 py-3 align-top">
                                        <Input 
                                            type="number" 
                                            {...register(`items.${index}.quantity` as const, { 
                                                valueAsNumber: true, 
                                                min: { value: 0, message: "Min 0" },
                                                validate: (value) => {
                                                    if (!itemValues.product_id) return true;
                                                    return value <= availableStock || `Max ${availableStock}`;
                                                }
                                            })}
                                            className={errors.items?.[index]?.quantity ? "border-red-500 focus:ring-red-500" : ""}
                                        />
                                        {itemValues.product_id && (
                                            <div className={`text-xs mt-1.5 font-bold flex items-center gap-1 ${errors.items?.[index]?.quantity ? "text-red-600" : "text-red-500"}`}>
                                               {errors.items?.[index]?.quantity ? (
                                                   <>
                                                    <AlertCircle className="w-3 h-3" />
                                                    {errors.items?.[index]?.quantity?.message || `Max: ${availableStock}`}
                                                   </>
                                               ) : (
                                                   `Max: ${availableStock}`
                                               )}
                                            </div>
                                        )}
                                    </td>
                                    <td className="px-4 py-3 align-top">
                                        <Input 
                                            type="number" 
                                            step="0.01"
                                            {...register(`items.${index}.inclusive_rate` as const, { valueAsNumber: true, min: 0 })}
                                        />
                                    </td>
                                    <td className="px-4 py-3 align-top pt-3 text-sm text-right text-slate-600 dark:text-slate-300 font-medium">
                                        {formatCurrency(taxable)}
                                    </td>
                                    <td className="px-4 py-3 align-top pt-3 text-sm text-right text-slate-900 dark:text-white font-semibold">
                                        {formatCurrency(total)}
                                    </td>
                                    <td className="px-4 py-3 align-top text-center pt-2">
                                        <button 
                                            type="button" 
                                            onClick={() => remove(index)}
                                            className="p-1.5 text-slate-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-md transition-colors"
                                            aria-label="Remove Item"
                                        >
                                            <Trash2 className="w-4 h-4" />
                                        </button>
                                    </td>
                                </tr>
                            );
                        })}
                        {fields.length === 0 && (
                            <tr>
                                <td colSpan={6} className="px-4 py-8 text-center text-slate-500 text-sm italic">
                                    No items added yet. Click below to start adding products.
                                </td>
                            </tr>
                        )}
                    </tbody>
                </table>
            </div>
            
            <Button 
                type="button" 
                variant="outline" 
                onClick={() => append({ 
                    product_id: '', 
                    product_name_display: '', 
                    quantity: 0, 
                    unit_price: 0, 
                    tax_rate: 0, 
                    inclusive_rate: 0,
                    unit_display: '',
                    hsn_code: '',
                    original_quantity: 0
                })}
                className="w-full sm:w-auto border-dashed border-slate-300 hover:border-slate-400 hover:bg-slate-50 text-slate-600"
            >
                <PlusCircle className="w-4 h-4 mr-2" /> Add New Item
            </Button>
        </div>

        {/* Footer Section */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">Notes / Terms</label>
                <textarea 
                    {...register('notes')}
                    rows={4}
                    placeholder="Enter notes or payment terms..."
                    className="flex w-full rounded-md border border-slate-300 bg-transparent py-2 px-3 text-sm placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-400 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-700 dark:text-slate-50 dark:focus:ring-slate-400 dark:focus:ring-offset-slate-900 mt-1 resize-none"
                />
            </div>
            <div className="bg-slate-50 dark:bg-slate-800/50 p-6 rounded-lg border border-slate-100 dark:border-slate-700">
                 <div className="space-y-3 text-sm">
                    <div className="flex justify-between items-center">
                        <span className="text-slate-600 dark:text-slate-400">Subtotal:</span>
                        <span className="font-medium text-slate-900 dark:text-white">{formatCurrency(totals.subtotal)}</span>
                    </div>
                    <div className="flex justify-between items-center">
                        <span className="text-slate-600 dark:text-slate-400">CGST:</span>
                        <span className="font-medium text-slate-900 dark:text-white">{formatCurrency(totals.cgst)}</span>
                    </div>
                    <div className="flex justify-between items-center">
                        <span className="text-slate-600 dark:text-slate-400">SGST:</span>
                        <span className="font-medium text-slate-900 dark:text-white">{formatCurrency(totals.sgst)}</span>
                    </div>
                    <div className="h-px bg-slate-200 dark:bg-slate-700 my-2"></div>
                    <div className="flex justify-between items-center text-lg font-bold">
                        <span className="text-slate-800 dark:text-slate-100">Grand Total:</span>
                        <span className="text-blue-600 dark:text-blue-400">{formatCurrency(totals.grandTotal)}</span>
                    </div>
                 </div>
            </div>
        </div>

        <div className="flex justify-end space-x-4 border-t dark:border-slate-700 pt-6">
            <Button type="button" variant="outline" onClick={onCancel} disabled={isSubmitting}>Cancel</Button>
            <Button type="submit" disabled={isSubmitting} className="px-8">
                {isSubmitting ? 'Saving...' : (invoice ? 'Update Invoice' : 'Create Invoice')}
            </Button>
        </div>
    </form>
  );
};

export default InvoiceForm;