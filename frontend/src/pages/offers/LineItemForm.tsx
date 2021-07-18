import _pick from 'lodash/pick'
import { ChangeEvent, FunctionComponent, useEffect, useState } from 'react'
import { useForm } from 'react-hook-form'
import Button from '../../components/Button'
import InlineError from '../../components/forms/InlineError'
import PlaceholderField from '../../components/forms/PlaceholderField'
import SelectField, { SelectOption } from '../../components/forms/SelectField'
import TextField from '../../components/forms/TextField'
import Spinner from '../../components/Spinner'
import {
  DANGEROUS_GOODS_LIST,
  LINE_ITEM_CATEGORY_OPTIONS,
  LINE_ITEM_CONTAINER_OPTIONS,
  PALLET_CONFIGS,
} from '../../data/constants'
import {
  DangerousGoods,
  GroupType,
  LineItemCategory,
  LineItemContainerType,
  LineItemUpdateInput,
  PalletType,
  useAllGroupsMinimalQuery,
  useLineItemQuery,
  useUpdateLineItemMutation,
} from '../../types/api-types'
import { setEmptyFieldsToUndefined } from '../../utils/data'
import {
  getContainerCountLabel,
  gramsToKilos,
  groupToSelectOption,
  kilosToGrams,
} from '../../utils/format'

interface Props {
  /**
   * The ID of the line item to display
   */
  lineItemId: number
  /**
   * Callback triggered when the user has finished editing the line item. The
   * parent component should handle this side effect.
   */
  onEditingComplete: () => void
  /**
   * The type of pallet for this line item. We use this to calculate the default
   * values for some form fields.
   */
  palletType: PalletType
}

const LineItemForm: FunctionComponent<Props> = ({
  lineItemId,
  onEditingComplete,
  palletType,
}) => {
  const {
    data,
    refetch,
    loading: lineItemIsLoading,
  } = useLineItemQuery({
    variables: { id: lineItemId },
  })

  const [receivingGroups, setReceivingGroups] = useState<SelectOption[]>([])
  const { data: groups } = useAllGroupsMinimalQuery()
  useEffect(
    function organizeGroups() {
      if (groups && groups.listGroups) {
        setReceivingGroups(
          groups.listGroups
            .filter((group) => group.groupType === GroupType.ReceivingGroup)
            .map(groupToSelectOption),
        )
      }
    },
    [groups],
  )

  /**
   * Store the list of dangerous goods. This logic works outside of
   * react-hook-form.
   */
  const [dangerousGoodsList, setDangerousGoodsList] = useState<
    DangerousGoods[]
  >([])
  /**
   * Force the user to confirm their selection when a pallet has no dangerous
   * goods.
   */
  const [confirmNoDangerousGoods, setConfirmNoDangerousGoods] = useState(false)
  /**
   * Show a validation error when the user didn't confirm that their pallet
   * contains no dangerous goods.
   */
  const [showDangerousGoodsError, setShowDangerousGoodsError] = useState(false)

  /**
   * Toggle the confirmation that the pallet contains no dangerous goods
   */
  const toggleNoDangerousGoods = (event: ChangeEvent<HTMLInputElement>) => {
    const checked = event.currentTarget.checked
    if (checked) {
      setConfirmNoDangerousGoods(true)
      setDangerousGoodsList([])
    } else {
      setConfirmNoDangerousGoods(false)
    }
    setShowDangerousGoodsError(false)
  }

  /**
   * Add or remove a category to the list of dangerous goods.
   */
  const toggleDangerousGood = (value: DangerousGoods) => {
    if (dangerousGoodsList.includes(value)) {
      setDangerousGoodsList(dangerousGoodsList.filter((g) => g !== value))
    } else {
      setDangerousGoodsList([...dangerousGoodsList, value])
      setConfirmNoDangerousGoods(false)
      setShowDangerousGoodsError(false)
    }
  }

  const {
    register,
    handleSubmit,
    reset,
    watch,
    setValue,
    formState: { errors },
  } = useForm<LineItemUpdateInput>()

  const watchContainerType = watch('containerType')
  const [watchContainerWidth, watchContainerLength, watchContainerHeight] =
    watch(['containerWidthCm', 'containerLengthCm', 'containerHeightCm'])

  useEffect(() => {
    const palletDimensions = PALLET_CONFIGS.find(
      (config) => config.type === palletType,
    )

    if (watchContainerType === LineItemContainerType.BulkBag) {
      // Do NOT pre-fill the height since it varies wildly
      if (!watchContainerWidth) {
        setValue('containerWidthCm', palletDimensions?.widthCm)
      }
      if (!watchContainerLength) {
        setValue('containerLengthCm', palletDimensions?.lengthCm)
      }
    } else if (watchContainerType === LineItemContainerType.FullPallet) {
      setValue('containerCount', 1) // There can only be one pallet per... pallet

      // Pre-fill dimensions if they're not already set
      if (!watchContainerWidth) {
        setValue('containerWidthCm', palletDimensions?.widthCm)
      }
      if (!watchContainerLength) {
        setValue('containerLengthCm', palletDimensions?.lengthCm)
      }
      if (!watchContainerHeight) {
        setValue('containerHeightCm', palletDimensions?.heightCm)
      }
    }
  }, [
    watchContainerType,
    palletType,
    watchContainerWidth,
    watchContainerHeight,
    watchContainerLength,
    setValue,
  ])

  useEffect(
    function fetchLineItem() {
      refetch({ id: lineItemId })
    },
    [lineItemId, refetch],
  )

  useEffect(
    function resetForm() {
      if (data?.lineItem) {
        reset({
          ...data.lineItem,
          containerWeightGrams: gramsToKilos(
            data.lineItem.containerWeightGrams || 0,
          ),
        })
        setDangerousGoodsList(data.lineItem.dangerousGoods)
      }
    },
    [data?.lineItem, reset],
  )

  const [updateLineItem, { loading: mutationIsLoading }] =
    useUpdateLineItemMutation()

  const submitForm = handleSubmit((input) => {
    if (!data?.lineItem) {
      return
    }

    // If the user hasn't checked any dangerous goods and hasn't checked the
    // "No dangerous goods" checkbox, we force them to
    if (!confirmNoDangerousGoods && dangerousGoodsList.length === 0) {
      setShowDangerousGoodsError(true)
      return
    }

    // Override the list of dangerous goods because it's not controlled by
    // react-hook-form
    input.dangerousGoods = dangerousGoodsList

    // Override the weight because we ask for it in kilos but want to store it
    // in grams
    if (input.containerWeightGrams) {
      input.containerWeightGrams = kilosToGrams(input.containerWeightGrams)
    }

    // We need to send all the fields from LineItemUpdateInput, even the ones
    // that didn't change. We then _pick the fields to make sure we don't send
    // things like `id` or `__typename`.
    let updatedLineItem = _pick(Object.assign({}, data.lineItem, input), [
      'status',
      'proposedReceivingGroupId',
      'acceptedReceivingGroupId',
      'containerType',
      'category',
      'description',
      'itemCount',
      'containerCount',
      'containerWeightGrams',
      'containerLengthCm',
      'containerWidthCm',
      'containerHeightCm',
      'affirmLiability',
      'tosAccepted',
      'dangerousGoods',
      'photoUris',
      'sendingHubDeliveryDate',
    ])

    // The backend doesn't want null values for optional fields
    updatedLineItem = setEmptyFieldsToUndefined(updatedLineItem)

    updateLineItem({
      variables: { id: lineItemId, input: updatedLineItem },
    }).then(() => {
      onEditingComplete()
    })
  })

  const containerCountLabel = getContainerCountLabel(
    watchContainerType || LineItemContainerType.Unset,
  )

  return (
    <form onSubmit={submitForm} className="pb-12">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-gray-700 text-lg flex items-center">
          Line Item {lineItemIsLoading && <Spinner className="ml-2" />}
        </h2>
        <div className="space-x-4">
          <Button onClick={onEditingComplete}>Cancel</Button>
          <Button variant="primary" type="submit" disabled={mutationIsLoading}>
            Save changes
          </Button>
        </div>
      </div>
      {receivingGroups.length > 0 ? (
        <SelectField
          name="proposedReceivingGroupId"
          label="Receiving group"
          castAsNumber
          required
          options={receivingGroups}
          register={register}
          errors={errors}
          className="mb-6 max-w-md"
        />
      ) : (
        <PlaceholderField className="mb-6 max-w-md" />
      )}
      <fieldset className="space-y-4">
        <legend className="font-semibold text-gray-700 ">Contents</legend>
        <TextField
          label="Description"
          name="description"
          required
          minLength={5}
          register={register}
          errors={errors}
          helpText="Pallets with comprehensive descriptions are more likely to get picked up."
        />
        <div className="md:flex md:space-x-4">
          <SelectField
            label="Container type"
            name="containerType"
            options={LINE_ITEM_CONTAINER_OPTIONS}
            register={register}
            required
            registerOptions={{
              validate: {
                notUnset: (value: LineItemContainerType) =>
                  value !== LineItemContainerType.Unset ||
                  'Please select a container type',
              },
            }}
            errors={errors}
          />
          <TextField
            label={containerCountLabel}
            name="containerCount"
            type="number"
            min={1}
            required
            register={register}
            errors={errors}
            disabled={watchContainerType === LineItemContainerType.FullPallet}
          />
          <TextField
            label="Number of items"
            name="itemCount"
            type="number"
            required
            min={1}
            register={register}
            errors={errors}
          />
        </div>
        <SelectField
          label="Category"
          name="category"
          options={LINE_ITEM_CATEGORY_OPTIONS}
          register={register}
          registerOptions={{
            validate: {
              notUnset: (value: LineItemCategory) =>
                value !== LineItemCategory.Unset || 'Please select a category',
            },
          }}
          required
          errors={errors}
        />
      </fieldset>
      <fieldset className="space-y-4 mt-12">
        <legend className="font-semibold text-gray-700 ">
          Container dimensions and weight
        </legend>
        <div className="md:flex md:space-x-4">
          <TextField
            label="Width (cm)"
            name="containerWidthCm"
            type="number"
            min={1}
            required
            register={register}
            errors={errors}
          />
          <TextField
            label="Length (cm)"
            name="containerLengthCm"
            type="number"
            min={1}
            required
            register={register}
            errors={errors}
          />
          <TextField
            label="Height (cm)"
            name="containerHeightCm"
            type="number"
            min={1}
            required
            register={register}
            errors={errors}
          />
        </div>
        <div className="md:w-1/3">
          {/* Note that we ask for KILOS but save the value in GRAMS */}
          <TextField
            label="Weight (kg)"
            name="containerWeightGrams"
            type="number"
            min={1}
            required
            register={register}
            errors={errors}
          />
        </div>
      </fieldset>

      <fieldset className="mt-12">
        <legend className="font-semibold text-gray-700 mb-4">
          Dangerous goods
        </legend>
        {showDangerousGoodsError && (
          <InlineError id="dangerous-goods-error">
            Please either confirm that there are no dangerous goods in this
            pallet or select the types of dangerous goods it includes.
          </InlineError>
        )}
        <label className="inline-flex items-center space-x-2 cursor-pointer mb-4">
          <input
            type="checkbox"
            checked={confirmNoDangerousGoods}
            onChange={toggleNoDangerousGoods}
          />
          <span>No dangerous goods</span>
        </label>
        <div className="md:grid grid-cols-3 rounded-sm gap-4">
          {DANGEROUS_GOODS_LIST.map((good) => (
            <label
              className="flex items-center space-x-2 cursor-pointer"
              key={good.value}
            >
              <input
                type="checkbox"
                checked={dangerousGoodsList.includes(good.value)}
                onChange={() => toggleDangerousGood(good.value)}
              />
              <span>{good.label}</span>
            </label>
          ))}
        </div>
      </fieldset>
    </form>
  )
}

export default LineItemForm
